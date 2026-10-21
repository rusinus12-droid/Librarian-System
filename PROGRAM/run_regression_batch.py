import argparse, fnmatch, json, os, sys, time, pathlib, subprocess, signal, tempfile
# Windows consoles may use cp949; a test's Unicode output must not abort the run.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(errors='backslashreplace')
root=pathlib.Path(__file__).resolve().parent

def _reports_suite_skip(output):
    # Explicit markers retain the existing partial-skip convention. JSON flags
    # apply only to complete suite documents, never nested product diagnostics.
    if 'SKIP:' in output:
        return True
    decoder=json.JSONDecoder()
    position=0
    while position<len(output):
        while position<len(output) and output[position].isspace():
            position+=1
        if position>=len(output):
            break
        if output[position] in '{[':
            try:
                document,end=decoder.raw_decode(output,position)
            except json.JSONDecodeError:
                pass
            else:
                if isinstance(document,dict) and document.get('skipped') is True:
                    return True
                position=end
                continue
        # Non-JSON log text is skipped as a line, so braces within messages
        # cannot be mistaken for independent suite documents.
        newline=output.find('\n',position)
        position=len(output) if newline<0 else newline+1
    return False

class _OwnedWindowsProcessJob:
    """Keep a regression's child processes inside an owned, kill-on-close job."""
    def __init__(self, handle, kernel32):
        self.handle=handle
        self.kernel32=kernel32

    def terminate(self):
        return bool(self.handle and self.kernel32.TerminateJobObject(self.handle, 1))

    def wait_empty(self, timeout_seconds=5):
        import ctypes
        from ctypes import wintypes
        class BasicAccountingInformation(ctypes.Structure):
            _fields_=[('TotalUserTime',ctypes.c_longlong),('TotalKernelTime',ctypes.c_longlong),
                      ('ThisPeriodTotalUserTime',ctypes.c_longlong),('ThisPeriodTotalKernelTime',ctypes.c_longlong),
                      ('TotalPageFaultCount',wintypes.DWORD),('TotalProcesses',wintypes.DWORD),
                      ('ActiveProcesses',wintypes.DWORD),('TotalTerminatedProcesses',wintypes.DWORD)]
        deadline=time.monotonic()+timeout_seconds
        while True:
            info=BasicAccountingInformation(); returned=wintypes.DWORD()
            if not self.kernel32.QueryInformationJobObject(self.handle,1,ctypes.byref(info),ctypes.sizeof(info),ctypes.byref(returned)):
                return False
            if info.ActiveProcesses==0:
                return True
            if time.monotonic()>=deadline:
                return False
            time.sleep(0.05)

    def close(self):
        if self.handle:
            handle=self.handle
            self.handle=None
            self.kernel32.CloseHandle(handle)

def _attach_owned_windows_job(process):
    if os.name!='nt':
        return None, 'not_windows'
    import ctypes
    from ctypes import wintypes

    class IoCounters(ctypes.Structure):
        _fields_=[('ReadOperationCount',ctypes.c_ulonglong),('WriteOperationCount',ctypes.c_ulonglong),
                  ('OtherOperationCount',ctypes.c_ulonglong),('ReadTransferCount',ctypes.c_ulonglong),
                  ('WriteTransferCount',ctypes.c_ulonglong),('OtherTransferCount',ctypes.c_ulonglong)]

    class BasicLimitInformation(ctypes.Structure):
        _fields_=[('PerProcessUserTimeLimit',ctypes.c_longlong),('PerJobUserTimeLimit',ctypes.c_longlong),
                  ('LimitFlags',wintypes.DWORD),('MinimumWorkingSetSize',ctypes.c_size_t),
                  ('MaximumWorkingSetSize',ctypes.c_size_t),('ActiveProcessLimit',wintypes.DWORD),
                  ('Affinity',ctypes.c_size_t),('PriorityClass',wintypes.DWORD),
                  ('SchedulingClass',wintypes.DWORD)]

    class ExtendedLimitInformation(ctypes.Structure):
        _fields_=[('BasicLimitInformation',BasicLimitInformation),('IoInfo',IoCounters),
                  ('ProcessMemoryLimit',ctypes.c_size_t),('JobMemoryLimit',ctypes.c_size_t),
                  ('PeakProcessMemoryUsed',ctypes.c_size_t),('PeakJobMemoryUsed',ctypes.c_size_t)]

    kernel32=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel32.CreateJobObjectW.argtypes=[wintypes.LPVOID,wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype=wintypes.HANDLE
    kernel32.SetInformationJobObject.argtypes=[wintypes.HANDLE,ctypes.c_int,wintypes.LPVOID,wintypes.DWORD]
    kernel32.SetInformationJobObject.restype=wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes=[wintypes.HANDLE,wintypes.HANDLE]
    kernel32.AssignProcessToJobObject.restype=wintypes.BOOL
    kernel32.TerminateJobObject.argtypes=[wintypes.HANDLE,wintypes.UINT]
    kernel32.TerminateJobObject.restype=wintypes.BOOL
    kernel32.QueryInformationJobObject.argtypes=[wintypes.HANDLE,ctypes.c_int,wintypes.LPVOID,wintypes.DWORD,ctypes.POINTER(wintypes.DWORD)]
    kernel32.QueryInformationJobObject.restype=wintypes.BOOL
    kernel32.CloseHandle.argtypes=[wintypes.HANDLE]
    kernel32.CloseHandle.restype=wintypes.BOOL

    handle=kernel32.CreateJobObjectW(None,None)
    if not handle:
        return None, f'job_create_failed:{ctypes.get_last_error()}'
    transferred=False
    try:
        info=ExtendedLimitInformation()
        info.BasicLimitInformation.LimitFlags=0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel32.SetInformationJobObject(handle,9,ctypes.byref(info),ctypes.sizeof(info)):
            return None, f'job_policy_failed:{ctypes.get_last_error()}'
        if not kernel32.AssignProcessToJobObject(handle,wintypes.HANDLE(int(process._handle))):
            return None, f'job_assign_failed:{ctypes.get_last_error()}'
        job=_OwnedWindowsProcessJob(handle,kernel32)
        transferred=True
        return job, 'job_object'
    finally:
        if not transferred:
            kernel32.CloseHandle(handle)

REGRESSION_OWNER_ENV='LIBRARIAN_REGRESSION_OWNER'
# Artifact verification suites check actual Full/Min builds that a release run hands them (the
# distribution builder sets these variables). They fail by design when the input is absent, so
# a full run without the inputs does not execute them and reports them as INPUT_REQUIRED: neither
# a pass nor a product failure. With the variables set they run and count normally.
EXPLICIT_INPUT_SUITES = {
    'build_plugins_artifact_behavior_negative_control_test.cjs': ('ULTRALIGHT_ARTIFACT_DIR', 'RELEASE_PARITY_CONTROL_DIR'),
    'build_plugins_artifact_behavior_parity_test.cjs': ('ULTRALIGHT_ARTIFACT_DIR', 'RELEASE_PARITY_CONTROL_DIR'),
    'build_plugins_artifact_libra_readiness_test.cjs': ('ULTRALIGHT_ARTIFACT_DIR',),
    'execution_task_profiles_artifact_test.cjs': ('EXECUTION_PROFILE_ARTIFACTS',),
    'flashback_server_inspection_artifact_test.cjs': ('FLASHBACK_SERVER_INSPECTION_ARTIFACTS',),
    'lia_manual_release_artifact_test.cjs': ('LIA_RELEASE_ARTIFACT',),
}

def _enable_posix_subreaper():
    """Linux: make the runner the reaper of orphaned test descendants.

    Without this, a descendant whose parent exits is re-parented to init and its
    lineage is lost; one that also replaced its environment (no owner token) can
    then no longer be attributed to the test. As a child subreaper, the runner
    receives such orphans, so they stay discoverable as its children."""
    if not sys.platform.startswith('linux'):
        return False
    try:
        import ctypes
        libc=ctypes.CDLL(None, use_errno=True)
        return libc.prctl(36, 1, 0, 0, 0)==0  # PR_SET_CHILD_SUBREAPER
    except Exception:
        return False

def _posix_process_table():
    """{pid: (ppid, state)} for every visible process; {} when it cannot be read.
    /proc is read directly on Linux so collecting the table starts no child process."""
    table={}
    if os.path.isdir('/proc'):
        for entry in os.listdir('/proc'):
            if not entry.isdigit(): continue
            try:
                with open(f'/proc/{entry}/stat','rb') as handle: data=handle.read()
                fields=data[data.rindex(b')')+2:].split()  # the command name may itself contain ')'
                table[int(entry)]=(int(fields[1]), fields[0].decode('ascii','replace'))
            except Exception:
                pass
        return table
    try:
        listing=subprocess.run(['ps','-A','-o','pid=','-o','ppid=','-o','stat='],capture_output=True,text=True,timeout=10).stdout
        for line in listing.splitlines():
            parts=line.split()
            if len(parts)>=2 and parts[0].isdigit() and parts[1].isdigit():
                table[int(parts[0])]=(int(parts[1]), parts[2][:1] if len(parts)>2 else '?')
    except Exception:
        pass
    return table

class _PosixOrphanReaper:
    """With the runner as subreaper, orphaned test descendants that exit become the runner's
    zombies. Init would reap them at once; this does the same so a test that waits for a
    detached process to disappear still observes it. Test roots started by Popen are never
    reaped here: their exit status belongs to Popen.wait(), and a stolen status would turn a
    failure into a reported pass. `spawning` covers the Popen-to-registration window."""
    def __init__(self):
        import threading
        self.protected=set(); self.lock=threading.Lock(); self.stopped=threading.Event()
        self.thread=threading.Thread(target=self._run, name='orphan-reaper', daemon=True)
        self.thread.start()

    def reap(self):
        own=os.getpid()
        with self.lock:
            for pid,(ppid,state) in _posix_process_table().items():
                if ppid==own and state=='Z' and pid not in self.protected:
                    try: os.waitpid(pid, os.WNOHANG)
                    except Exception: pass

    def _run(self):
        while not self.stopped.wait(0.1):
            self.reap()

def _posix_owned_pids(token, root_pid, root_alive=True, subreaper=False):
    """POSIX: processes started for one regression, including detached ones.

    A process group kill misses descendants that call setsid()/detached spawn.
    Every test receives an owner token in its environment, inherited by every
    descendant that keeps the environment; those are found through /proc
    (Linux) or `ps eww` (BSD/macOS). The parent table then adds every descendant
    of those processes, of the still-running root and, when the runner is the
    subreaper, of the runner itself (orphans re-parented to it). Each found
    process is expanded, so an environment-replacing grandchild below a
    token-holding child is found as well."""
    own=os.getpid(); found=set(); needle=(REGRESSION_OWNER_ENV+'='+token).encode()
    if os.path.isdir('/proc'):
        for entry in os.listdir('/proc'):
            if not entry.isdigit(): continue
            try:
                with open(f'/proc/{entry}/environ','rb') as handle:
                    if needle in handle.read().split(b'\0'): found.add(int(entry))
            except Exception:
                pass
    else:
        try:
            listing=subprocess.run(['ps','eww','-A','-o','pid=','-o','command='],capture_output=True,text=True,timeout=10).stdout
            for line in listing.splitlines():
                parts=line.strip().split(None,1)
                if len(parts)==2 and parts[0].isdigit() and (REGRESSION_OWNER_ENV+'='+token) in parts[1]: found.add(int(parts[0]))
        except Exception:
            pass
    # 부모 표 확장의 출발점: 토큰으로 확인된 살아 있는 프로세스(지금의 자식은 실제 자손이다),
    # 살아 있는 루트, 서브리퍼일 때 실행기 자신(재부모화된 고아). 끝난 루트의 PID는 재사용됐을 수 있어 쓰지 않는다.
    seeds=set(found)
    if root_alive: seeds.add(root_pid)
    if subreaper: seeds.add(own)
    table=_posix_process_table()
    children={}
    for pid,(ppid,_state) in table.items(): children.setdefault(ppid,[]).append(pid)
    visited=set(); pending=list(seeds)
    while pending:
        current=pending.pop()
        if current in visited: continue
        visited.add(current)
        for child in children.get(current,[]):
            found.add(child)
            if child not in visited: pending.append(child)  # 토큰으로 이미 찾은 자식도 그 아래를 계속 탐색한다
    found.discard(own)
    return found

def _posix_is_live(pid):
    """True for a running process; an exited one that only awaits reaping (zombie) is not live."""
    try: os.kill(pid, 0)
    except Exception: return False
    if os.path.isdir('/proc'):
        try:
            with open(f'/proc/{pid}/stat','rb') as handle: data=handle.read()
            return data[data.rindex(b')')+2:].split()[0]!=b'Z'
        except Exception:
            return False  # 그사이 사라졌다
    return True

def _posix_terminate_owned(token, proc, subreaper=False, reaper=None):
    """Kill every owned process of one test (and its process group). Returns (killed_count, survivors).

    Lineage is collected before anything is killed: killing the root first would orphan its
    descendants and lose the parent links that attribute token-less (environment-replaced)
    processes to this test. Collected processes are stopped first so none can fork while the
    set is being killed; collection is then repeated until nothing owned remains."""
    own_group=os.getpgrp(); killed=set()
    def collect():
        return {pid for pid in _posix_owned_pids(token, proc.pid, proc.poll() is None, subreaper)-{proc.pid} if _posix_is_live(pid)}
    for attempt in range(6):
        alive=collect()
        if attempt>0 and not alive: break
        for pid in alive:
            try: os.kill(pid, signal.SIGSTOP)
            except Exception: pass
        if attempt==0:
            # 루트의 그룹 ID는 그룹 구성원이 남아 있는 동안 재사용되지 않으므로 루트 종료 뒤에도 안전하다.
            try: os.killpg(proc.pid, signal.SIGKILL)
            except Exception: pass
        for pid in alive:
            try:
                group=os.getpgid(pid)
                if group!=own_group: os.killpg(group, signal.SIGKILL)
            except Exception: pass
            try: os.kill(pid, signal.SIGKILL)
            except Exception: pass
            killed.add(pid)
        if not alive: break
        time.sleep(0.2)
    if reaper: reaper.reap()
    survivors=collect()
    return len(killed), survivors

def _unlink_regression_output(path, timeout_seconds=5):
    deadline=time.monotonic()+timeout_seconds
    while True:
        try:
            path.unlink(missing_ok=True)
            return True
        except PermissionError:
            if time.monotonic()>=deadline:
                return False
            time.sleep(0.05)

# These multi-scenario suites exercise real HTTP/SQLite durable commits. On
# Windows their successful aggregate runtime exceeds 60s; individual assertions
# and in-test observation deadlines remain unchanged. Keep a bounded file limit.
TEST_TIMEOUT_SECONDS = {
    # Actual six-plugin pinned release build and all artifact/negative controls: 126.662s.
    # Bound aggregate execution at 180s; existing build/minifier deadlines are unchanged.
    'test_surface_strip_test.cjs': 180,
    # Preserved five-scenario local Persona dialog: standalone 135.109s,
    # unchanged case deadlines; 180s bounds aggregate scheduling overhead.
    'retrace_dialog_lifecycle_gui_test.cjs': 180,
    # All 29 current raw-COW cases complete naturally in 133.607s. Preserve case
    # deadlines and the earlier default60 timeout; allow bounded file overhead.
    'flashback_raw_cow_append_runtime_test.cjs': 180,
    # Current raw-first 31-ready / failed-vector / explicit-retry / rebuild matrix
    # completes naturally in 89.180s; preserve internal action deadlines.
    'flashback_single_turn_maintenance_runtime_test.cjs': 120,
    # Real bounded archive repair plus retained 640-row legacy overlay matrix
    # completes naturally in 74.491s; unchanged in-test/provider limits.
    'flashback_portable_cross_chat_restore_test.cjs': 120,
    # Three-mode descriptor/tamper matrix: 55.77s isolated, 66.07s in this runner.
    # Preserve the default60 timeout evidence and case deadlines; margin is 36%.
    'libra_main_memory_thread_lifecycle_boundary_matrix_test.cjs': 90,
    # Functional 3-source x 3-destination portable matrix; default60 timeout retained as prior evidence.
    'libra_phase_d_portable_nine_pairs_test.cjs': 180,
    # Nested GRADIA source/preservation suites measured 117.69s under source audit.
    # This is one discovered suite; retain its individual test deadlines unchanged.
    'gradia_suite_test.cjs': 240,
    # All three modes complete in 138.20s in the source-audit measurement;
    # preserve in-test deadlines and allow 30% aggregate scheduling margin.
    'libra_micro_inherited_t5_overlap_3mode_test.cjs': 180,
    'libra_micro_state_admission_3mode_test.cjs': 90,  # 66.31s natural; in-test deadlines unchanged.
    'libra_micro_state_frontier_3mode_test.cjs': 110,  # 79.03s with cutoff/reopen/restart checks.
    # Multi-mode ceilings are based on natural, isolated suite runtimes plus a
    # bounded margin; per-test contract deadlines and assertions are unchanged.
    # Three-mode 105-pair lifecycle: isolated runtimes total 640.57s; 840s gives
    # a bounded 31% margin for the sequential default run and final readbacks.
    'libra_main_memory_letter_lifecycle_105turn_test.cjs': 840,
    'libra_main_memory_semantic_history_test.cjs': 120,  # 81.81s natural, 47% margin.
    'libra_phase_d_a05_action_matrix_test.cjs': 150,  # 114.68s natural, 31% margin.
    'libra_phase_d_a11_same_title_promises_test.cjs': 125,  # 91.54s natural, 37% margin.
    'libra_phase_d_a13_four_outcomes_test.cjs': 210,  # 160.24s natural, 31% margin.
    'libra_phase_d_a15_invalid_links_test.cjs': 135,  # 100.50s natural, 34% margin.
    'libra_phase_d_a25_correction_test.cjs': 90,  # 67.21s natural, 34% margin.
    # 41-seed candidate scale, cancellation/readback and successor: isolated
    # modes total 1,427.85s; 1,800s gives a 26% aggregate margin.
    'libra_phase_d_candidate_context_scale_test.cjs': 1800,
    # 65-batch semantic timeline modes total 2,634.65s in isolated runs;
    # 3,300s leaves 25% for the sequential default run and final readbacks.
    'libra_phase_d_timeline_caps_test.cjs': 3300,
    'libra_response_variant_missing_canonical_catchup_test.cjs': 240,  # 184.21s natural, 30% margin.
    'libra_state_head_concurrent_rebuild_test.cjs': 100,  # 71.24s natural, 40% margin.
    'libra_worldline_async_isolation_3mode_test.cjs': 110,  # 79.80s natural, 38% margin.
    # 288.02s was the repeated-measurement checkpoint, not process completion.
    # The same source/test finished all cancellation probes in 394.17s; 500s
    # bounds the full suite with a 27% margin without changing in-test limits.
    'libra_phase_d_candidate_context_scale_synthetic_test.cjs': 500,
    'libra_source_edit_final_injection_3mode_test.cjs': 100,  # 72.87s natural, 37% margin.
    'libra_unified_server_vector_v1_test.cjs': 240,
    'libra_unified_server_writer_v1_test.cjs': 240,
    'libra_mirror_linkage_runtime_test.cjs': 180,
    # 50 forced-concurrency iterations; each boots a real HTTP server + SQLite
    # scope and holds the manifest conditional batch on the lock boundary.
    'native_branch_flashback_legacy_child_migration_concurrency_test.cjs': 300,
    # These also exceed the default 60s on a healthy host, so the default made
    # them flaky rather than failing: measured standalone runtimes are
    # hayaku_server_only_recovery_shards 96s (TIMEOUT'd mid-scenario at 60.00s),
    # remote_update_release_zip_runtime 51-63s (PASS at 56.13s in the 0.3.63
    # baseline), prior_work_harness_regression 25s (spawns four plugin harnesses,
    # so it fails mid-run when the host is loaded). The in-test observation
    # deadlines still bound each scenario; this only stops the harness from
    # cutting a suite off while it is still making progress.
    'hayaku_server_only_recovery_shards_test.cjs': 300,
    'remote_update_release_zip_runtime_test.cjs': 300,
    'prior_work_harness_regression_test.cjs': 180,
    # Boots a real HTTP/SQLite server plus the real HAYAKU and RE:TRACE plugins once per storage
    # mode, so its healthy standalone runtime is 64-65s — over the default 60s. Measured: 3/3 PASS
    # at 64s/65s; the mode loop is bounded internally.
    'retrace_roles_e2e_test.cjs': 300,
    # Both of these drive the REAL distribution builder: it copies the whole source tree and then
    # spawns `node --test` over the 74 release-smoke suites, so they are load-sensitive in a way the
    # default 60s does not tolerate. distribution_builder_failure_runtime measured 22-23s in five
    # consecutive runs and 60.02s (TIMEOUT) in the sixth; remote_update_release_zip measured 54-67s
    # standalone and 81-89s under load. The in-test observation deadlines still bound each scenario;
    # this only stops the harness from cutting a suite off while it is still working.
    'distribution_builder_failure_runtime_test.cjs': 300,
}
all_tests=sorted(
    test for test in (root/'tests').glob('*.cjs')
    if test.name.endswith('_test.cjs') or test.name.endswith('.test.cjs')
)
parser=argparse.ArgumentParser(description='Run all CJS regressions, or select suites by filename glob.')
parser.add_argument('start', nargs='?', type=int, default=0, help='zero-based start in the full sorted inventory')
parser.add_argument('end', nargs='?', type=int, help='exclusive end in the full sorted inventory')
parser.add_argument('--match', action='append', default=[], metavar='GLOB', help='include matching filenames; repeat for alternatives')
parser.add_argument('--exclude', action='append', default=[], metavar='GLOB', help='exclude matching filenames')
parser.add_argument('--list', action='store_true', help='print the selected filenames without executing or writing logs')
selection=parser.parse_args()
start=selection.start
end=selection.end if selection.end is not None else len(all_tests)
if start<0 or end<=start or start>=len(all_tests):
    parser.error('range must select at least one existing test (0 <= start < end)')
selected_indices=[idx for idx in range(start,min(end,len(all_tests)))
    if (not selection.match or any(fnmatch.fnmatchcase(all_tests[idx].name, pattern) for pattern in selection.match))
    and not any(fnmatch.fnmatchcase(all_tests[idx].name, pattern) for pattern in selection.exclude)]
if not selected_indices:
    parser.error('no tests matched; no execution or successful empty result')
if selection.list:
    print('\n'.join(all_tests[idx].name for idx in selected_indices))
    sys.exit(0)
filtered=bool(selection.match or selection.exclude)
package_version=(root/'VERSION.txt').read_text(encoding='utf-8').strip()
manifest=json.loads((root/'program-manifest.json').read_text(encoding='utf-8'))
plugin_versions=manifest.get('plugins',{})
child_env=os.environ.copy()
child_env['PYTHON']=child_env.get('PYTHON') or sys.executable

def _prepare_build_support(env):
    """Expose the locked build-support modules (jsdom, acorn, terser, fake-indexeddb) to every suite.

    The distribution builder does this before its release smoke; without it a fresh checkout fails
    DOM and minifier suites on a missing module instead of on what they test.
    """
    script=("const {ensureBuildSupportDependencies}=require(process.argv[1]);"
            "const r=ensureBuildSupportDependencies({programDir:process.argv[2],installIfMissing:process.argv[3]==='1'});"
            "process.stdout.write(String(r&&r.modulesDir||''));")
    install='0' if env.get('MEMORY_SUITE_REGRESSION_NO_INSTALL')=='1' else '1'
    try:
        done=subprocess.run(['node','-e',script,str(root/'tools'/'ensure_build_support.cjs'),str(root),install],
                            cwd=root,capture_output=True,text=True,timeout=900,env=env)
    except Exception as exc:
        return '', f'build-support preparation failed: {type(exc).__name__}'
    modules=done.stdout.strip() if done.returncode==0 else ''
    if not modules:
        return '', 'build-support unavailable: ' + (done.stderr.strip().splitlines() or ['unknown'])[-1][:300]
    current=[part for part in env.get('NODE_PATH','').split(os.pathsep) if part]
    if modules not in current:
        env['NODE_PATH']=os.pathsep.join([modules,*current])
    env.setdefault('GRADIA_TOOLCHAIN_ROOT',modules)
    return modules, ''

build_support_dir, build_support_warning=_prepare_build_support(child_env)
default_log_name=f'SELECTED_TEST_EXECUTION_LOG_{package_version}.txt' if filtered else f'FULL_TEST_EXECUTION_LOG_{package_version}.txt'
log_path=pathlib.Path(os.environ.get('MEMORY_SUITE_REGRESSION_LOG', str(root.parents[1] / default_log_name)))
output_dir_env=os.environ.get('MEMORY_SUITE_REGRESSION_OUTPUT_DIR')
output_dir=pathlib.Path(output_dir_env) if output_dir_env else None
if output_dir:
    output_dir.mkdir(parents=True,exist_ok=True)
mode='w' if filtered or start==0 else 'a'
with log_path.open(mode,encoding='utf-8') as log:
    if filtered or start==0:
        log.write(
            f"Librarian System {package_version} — "
            f"LIBRA {plugin_versions.get('libra','unknown')} / "
            f"HAYAKU {plugin_versions.get('hayaku','unknown')} / "
            f"Flashback {plugin_versions.get('flashback','unknown')} / "
            f"LIA {plugin_versions.get('lia','unknown')} / "
            f"RE:TRACE {plugin_versions.get('retrace','unknown')} / "
            f"GRADIA {plugin_versions.get('gradia','unknown')} {'selected' if filtered else 'full'} CJS regression execution\n"
        )
        log.write(f'Tests: {len(all_tests)}; selected: {len(selected_indices)}\n\n')
        if filtered:
            log.write(f'Selection: match={json.dumps(selection.match)}; exclude={json.dumps(selection.exclude)}\n\n')
        log.write(f'Timeout seconds: default=60; overrides={json.dumps(TEST_TIMEOUT_SECONDS, sort_keys=True)}\n\n')
        log.write(f"Build support: {build_support_dir or 'UNAVAILABLE — ' + build_support_warning}\n\n")
        log.flush()
    failures=0; timeouts=0; skips=0
    posix_subreaper=False; orphan_reaper=None
    if os.name!='nt':
        # SIGTERM(종료 요청·timeout 명령)도 Ctrl-C와 같은 정리 경로를 거친다. 그대로 죽으면 시험이 띄운 서버가 남는다.
        def _terminate_as_interrupt(signum, frame): raise KeyboardInterrupt()
        signal.signal(signal.SIGTERM, _terminate_as_interrupt)
        posix_subreaper=_enable_posix_subreaper()
        if posix_subreaper: orphan_reaper=_PosixOrphanReaper()
        if filtered or start==0:
            log.write(f"POSIX cleanup: owner token + parent table; subreaper={'on' if posix_subreaper else 'off'}\n\n"); log.flush()
    input_required=0
    for idx in selected_indices:
        test=all_tests[idx]
        missing_inputs=[name for name in EXPLICIT_INPUT_SUITES.get(test.name,()) if not child_env.get(name)]
        if missing_inputs:
            input_required+=1
            line=f'{idx+1:02d}/{len(all_tests)} {test.name}: INPUT_REQUIRED 0.00s [not run; set {", ".join(missing_inputs)}]'
            print(line,flush=True); log.write(line+'\n'); log.flush()
            continue
        fd, tmp_name = tempfile.mkstemp(prefix=f'librarian-regression-{os.getpid()}-{idx}-', suffix='.txt')
        os.close(fd)
        tmp=pathlib.Path(tmp_name)
        st=time.time()
        with tmp.open('w+',encoding='utf-8',errors='replace') as out:
            test_command=['node',str(test)]
            owner_token=f'{os.getpid()}-{idx}-{os.urandom(4).hex()}'
            test_env=dict(child_env, **{REGRESSION_OWNER_ENV: owner_token})
            if os.name=='nt':
                # The waiting shim starts no test code until after assignment. This removes the
                # Popen-to-AssignProcessToJobObject race for test descendants.
                launcher="import subprocess,sys; sys.stdin.readline(); raise SystemExit(subprocess.call(sys.argv[1:]))"
                proc=subprocess.Popen([sys.executable,'-c',launcher,*test_command],cwd=root,stdin=subprocess.PIPE,stdout=out,stderr=subprocess.STDOUT,start_new_session=True,text=True,env=test_env)
            elif orphan_reaper:
                # 등록 전에 곧바로 끝난 시험 루트를 고아 회수기가 가져가지 않도록 같은 잠금 안에서 띄우고 보호한다.
                with orphan_reaper.lock:
                    proc=subprocess.Popen(test_command,cwd=root,stdin=subprocess.DEVNULL,stdout=out,stderr=subprocess.STDOUT,start_new_session=True,text=True,env=test_env)
                    orphan_reaper.protected.add(proc.pid)
            else:
                proc=subprocess.Popen(test_command,cwd=root,stdin=subprocess.DEVNULL,stdout=out,stderr=subprocess.STDOUT,start_new_session=True,text=True,env=test_env)
            tree_job=None; tree_status='not_windows'; timeout_cleanup='not_timed_out'
            status='PASS'
            try:
                if os.name=='nt':
                    try: tree_job,tree_status=_attach_owned_windows_job(proc)
                    except Exception as exc: tree_status=f'job_attach_exception:{type(exc).__name__}'
                    if not tree_job:
                        # The shim is still waiting and has not launched the test. Fail closed;
                        # do not run an unowned regression or imply descendant cleanup.
                        status='FAIL'; failures+=1
                        timeout_cleanup='launcher_stopped_before_test_start;no_child_cleanup_claimed'
                        try: proc.kill()
                        except Exception: pass
                        try: proc.wait(timeout=5)
                        except Exception: pass
                    else:
                        try:
                            proc.stdin.write('start\n'); proc.stdin.flush(); proc.stdin.close()
                        except Exception as exc:
                            status='FAIL'; failures+=1
                            timeout_cleanup=f'test_launch_failed:{type(exc).__name__}'
                            tree_job.terminate()
                            try: proc.wait(timeout=5)
                            except Exception: pass
                if status=='PASS':
                    try:
                        try:
                            rc=proc.wait(timeout=TEST_TIMEOUT_SECONDS.get(test.name, 60))
                        except KeyboardInterrupt:
                            # start_new_session 때문에 Ctrl-C가 자식에게 전달되지 않는다. 시험이 띄운 서버가
                            # (별도 프로세스 그룹으로 분리된 detached 서버 포함) 남지 않게 정리한 뒤 중단한다.
                            if os.name!='nt':
                                killed,survivors=_posix_terminate_owned(owner_token, proc, posix_subreaper, orphan_reaper)
                                sys.stderr.write(f'\n[regression] interrupted: {test.name}; terminated {killed} owned process(es)'+(f'; still alive: {sorted(survivors)}' if survivors else '')+'\n')
                            elif tree_job: tree_job.terminate()
                            raise
                        if rc!=0:
                            status='FAIL'; failures+=1
                        if os.name!='nt':
                            # 정상 종료 뒤 남은 자손(분리된 서버 포함)도 정리한다. Windows의 job drain과 같은 기준:
                            # 정리되면 결과는 그대로, 정리되지 않으면 FAIL.
                            killed,survivors=_posix_terminate_owned(owner_token, proc, posix_subreaper, orphan_reaper)
                            if survivors:
                                timeout_cleanup=f'posix_owned_drain_failed:{len(survivors)}'
                                if status=='PASS': status='FAIL'; failures+=1
                            elif killed:
                                timeout_cleanup=f'posix_owned_leftovers_terminated:{killed}'
                        if tree_job:
                            tree_job.terminate()
                            if tree_job.wait_empty(5):
                                timeout_cleanup='owned_job_drained_after_exit'
                            else:
                                timeout_cleanup='owned_job_drain_failed_after_exit'
                                if status=='PASS': status='FAIL'; failures+=1
                    except subprocess.TimeoutExpired:
                        status='TIMEOUT'; timeouts+=1
                        if tree_job:
                            terminated=tree_job.terminate()
                            empty=tree_job.wait_empty(5)
                            if empty:
                                timeout_cleanup='owned_job_tree_terminated' if terminated else 'owned_job_already_empty'
                            else:
                                timeout_cleanup='owned_job_terminate_failed;owned_job_drain_failed;main_process_only_fallback'
                                try: proc.kill()
                                except Exception: pass
                        elif os.name=='nt':
                            timeout_cleanup='main_process_only_fallback:'+tree_status
                            try: proc.kill()
                            except Exception: pass
                        else:
                            killed,survivors=_posix_terminate_owned(owner_token, proc, posix_subreaper, orphan_reaper)
                            timeout_cleanup=('posix_owned_tree_terminated' if not survivors else f'posix_owned_drain_failed:{len(survivors)}')+f';owned_killed={killed}'
                            try: proc.kill()
                            except Exception: pass
                        try: proc.wait(timeout=5)
                        except Exception: pass
            finally:
                if orphan_reaper and proc.returncode is not None:
                    with orphan_reaper.lock: orphan_reaper.protected.discard(proc.pid)  # 회수 완료: 재사용될 PID는 보호하지 않는다
                # KILL_ON_JOB_CLOSE is a final safety net; explicit drain above lets Windows
                # release descendants' inherited stdout handles before the temp log is unlinked.
                try:
                    if tree_job:
                        tree_job.close()
                finally:
                    if os.name=='nt' and proc.stdin and not proc.stdin.closed:
                        proc.stdin.close()
        elapsed=time.time()-st
        raw_output=tmp.read_text(encoding='utf-8',errors='replace')
        output=raw_output.strip().replace('\n',' | ')
        output_artifact=None
        if output_dir:
            output_artifact=output_dir/f'{idx+1:03d}-{test.name}.log'
            output_artifact.write_bytes(tmp.read_bytes())
        temp_removed=_unlink_regression_output(tmp)
        if not temp_removed and status in ('PASS','PASS_SKIP'):
            status='FAIL'; failures+=1
        # A suite may print `SKIP: <reason>` when part of its work cannot run on this host
        # (no Chrome, a non-Windows host, ...). Exit code 0 alone cannot distinguish that from a
        # full pass, which is how a review of the 0.3.64 log found a skip counted as a plain PASS.
        # Such a suite is reported as PASS_SKIP so the log states what actually ran. It is NOT a
        # failure: the remaining contracts in the file were still executed.
        # JSON reports are parsed before log flattening, retaining pretty-printed
        # suite documents and distinguishing nested refusal/idempotence flags.
        # Count skips in the outer scope so the last suite cannot reset the total.
        if status=='PASS' and _reports_suite_skip(raw_output):
            status='PASS_SKIP'; skips+=1
        line=f'{idx+1:02d}/{len(all_tests)} {test.name}: {status} {elapsed:.2f}s [tree={tree_status}; cleanup={timeout_cleanup}]'
        if output_artifact: line+=f' [full_output_log={output_artifact}]'
        if not temp_removed:
            line=f'{idx+1:02d}/{len(all_tests)} {test.name}: {status} {elapsed:.2f}s [tree={tree_status}; cleanup={timeout_cleanup}; temp_output_retained={tmp}]'
        if output: line += ' :: ' + output[:1800]
        print(line,flush=True)
        log.write(line+'\n'); log.flush()
    if skips:
        summary=f'\nSuites reporting a partial skip (PASS_SKIP): {skips}. '\
                f'These exited 0 but stated that part of their work did not run on this host; '\
                f'they are counted as PASS for the exit code and separately here.\n'
        print(summary,flush=True); log.write(summary); log.flush()
    if input_required:
        summary=f'\nArtifact suites not run (INPUT_REQUIRED): {input_required}. They verify actual release '\
                f'builds and run when the distribution builder (or a caller) supplies their input variables.\n'
        print(summary,flush=True); log.write(summary); log.flush()
    sys.exit(1 if failures or timeouts else 0)
