import argparse, fnmatch, json, os, sys, time, pathlib, subprocess, signal, tempfile
# Windows consoles may use cp949; a test's Unicode output must not abort the run.
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(errors='backslashreplace')
root=pathlib.Path(__file__).resolve().parent

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
    # Preserved five-scenario local Persona dialog: standalone 135.109s,
    # unchanged case deadlines; 180s bounds aggregate scheduling overhead.
    'retrace_dialog_lifecycle_gui_test.cjs': 180,
    # All 29 raw-COW cases complete in 71.71s on restored A11. Preserve case
    # deadlines and the earlier default60 timeout; allow bounded file overhead.
    'flashback_raw_cow_append_runtime_test.cjs': 110,
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
            f"RE:TRACE {plugin_versions.get('retrace','unknown')} {'selected' if filtered else 'full'} CJS regression execution\n"
        )
        log.write(f'Tests: {len(all_tests)}; selected: {len(selected_indices)}\n\n')
        if filtered:
            log.write(f'Selection: match={json.dumps(selection.match)}; exclude={json.dumps(selection.exclude)}\n\n')
        log.write(f'Timeout seconds: default=60; overrides={json.dumps(TEST_TIMEOUT_SECONDS, sort_keys=True)}\n\n')
        log.flush()
    failures=0; timeouts=0; skips=0
    for idx in selected_indices:
        test=all_tests[idx]
        fd, tmp_name = tempfile.mkstemp(prefix=f'librarian-regression-{os.getpid()}-{idx}-', suffix='.txt')
        os.close(fd)
        tmp=pathlib.Path(tmp_name)
        st=time.time()
        with tmp.open('w+',encoding='utf-8',errors='replace') as out:
            test_command=['node',str(test)]
            if os.name=='nt':
                # The waiting shim starts no test code until after assignment. This removes the
                # Popen-to-AssignProcessToJobObject race for test descendants.
                launcher="import subprocess,sys; sys.stdin.readline(); raise SystemExit(subprocess.call(sys.argv[1:]))"
                proc=subprocess.Popen([sys.executable,'-c',launcher,*test_command],cwd=root,stdin=subprocess.PIPE,stdout=out,stderr=subprocess.STDOUT,start_new_session=True,text=True,env=child_env)
            else:
                proc=subprocess.Popen(test_command,cwd=root,stdout=out,stderr=subprocess.STDOUT,start_new_session=True,text=True,env=child_env)
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
                        rc=proc.wait(timeout=TEST_TIMEOUT_SECONDS.get(test.name, 60))
                        if rc!=0:
                            status='FAIL'; failures+=1
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
                            try:
                                os.killpg(proc.pid, signal.SIGKILL)
                                timeout_cleanup='process_group_terminated'
                            except Exception:
                                timeout_cleanup='main_process_only_fallback:process_group_kill_failed'
                                try: proc.kill()
                                except Exception: pass
                        try: proc.wait(timeout=5)
                        except Exception: pass
            finally:
                # KILL_ON_JOB_CLOSE is a final safety net; explicit drain above lets Windows
                # release descendants' inherited stdout handles before the temp log is unlinked.
                try:
                    if tree_job:
                        tree_job.close()
                finally:
                    if os.name=='nt' and proc.stdin and not proc.stdin.closed:
                        proc.stdin.close()
        elapsed=time.time()-st
        output=tmp.read_text(encoding='utf-8',errors='replace').strip().replace('\n',' | ')
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
        # TWO conventions count, because both are in use: the `SKIP:` marker line, and the
        # `skipped: true` JSON object that the model-recording suites emit when no capture exists.
        # Accepting only the first left the gemma suites reporting a plain PASS for work they never
        # did — the exact failure this check was added to catch.
        # NOTE: `skips` is counted in the outer scope — resetting it here made the end-of-run
        # summary depend on whether the LAST suite happened to be a skip (it never printed).
        if status=='PASS' and ('SKIP:' in output or '"skipped": true' in output or '"skipped":true' in output):
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
    sys.exit(1 if failures or timeouts else 0)
