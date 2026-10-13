"""Explicit-only source review UI in Chromium; synthetic owner evidence, real controller and DOM."""
from pathlib import Path
import json, sys, shutil
try:
    from playwright.sync_api import sync_playwright
except ModuleNotFoundError as error:
    if error.name != 'playwright':
        raise
    print(json.dumps({'test': 'source_review_browser', 'result': 'NOT_RUN', 'reason': 'Python Playwright is not installed'}))
    raise SystemExit(77)

P = Path(sys.argv[1])
E = Path(sys.argv[2])
E.mkdir(parents=True, exist_ok=True)
sdk = (P / 'sdk/MemorySuiteSourceEditConsent.source.js').read_text()
results = []
errors = []


def check(name, ok, detail=None):
    results.append({'name': name, 'ok': bool(ok), 'detail': detail})
    if not ok:
        raise AssertionError(name + ': ' + str(detail))


try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=shutil.which('chromium'), headless=True,
                                     args=['--no-sandbox', '--disable-dev-shm-usage'])
        for owner in ['libra', 'hayaku', 'flashback']:
            for width in [1440, 1024, 768, 390]:
                page = browser.new_page(viewport={'width': width, 'height': 1000 if width > 600 else 844})
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.set_content('<!doctype html><html lang="ko"><meta charset="utf-8"><body><button id="host">채팅 계속하기</button><main id="settings"></main></body></html>')
                page.add_script_tag(content=sdk)
                page.evaluate('''async owner => {
                  window.xss=0;window.storage=new Map();window.prompts=0;window.executions=[];window.evidenceReads=[];window.evidenceRowsSeen=[];window.collects=0;
                  window.units=[
                    {key:'32',start:32,end:32,label:'T32',identity:owner+'-pair-32',digest:owner+'-new-32',sourceDigest:owner+'-new-32',originalDigest:owner+'-old-32',basis:'basis-32',changed:true,current:false},
                    {key:'33',start:33,end:33,label:'T33',identity:owner+'-pair-33',digest:owner+'-new-33',sourceDigest:owner+'-new-33',originalDigest:owner+'-old-33',basis:'basis-33',changed:true,current:false}
                  ];
                  window.controller=createMemorySuiteSourceEditConsent({owner,requestBoundary:true,externalObserver:true,preserveUntilReplacement:true,
                    read:async key=>storage.get(key)??null,write:async(key,value)=>{storage.set(key,value);return true;},
                    collect:async()=>{collects++;return{scopeKey:'scope-'+owner,units:units.map(unit=>({...unit})),completedTurnIds:['logical-u32']};},
                    prompt:async()=>{prompts++;throw Error('automatic request-boundary work must not prompt');},
                    execute:async(task,permit)=>{await permit.assertCurrent();executions.push(task.key);units=units.map(unit=>unit.key===task.key?{...unit,changed:false,current:true}:unit);return{ok:true};},
                    loadReview:async(tasks,scopeKey)=>{const rows=tasks.map(task=>task.key==='32'
                      ?{key:'32',previousUnavailable:false,beforeText:'old '+owner+' <img src=x onerror="window.xss=1"> 😀',afterText:'new '+owner+' <img src=x onerror="window.xss=2"> 😁'}
                      :{key:'33',previousUnavailable:true,afterText:'current '+owner+' <script>window.xss=3</script>'});evidenceReads.push({owner,scopeKey,keys:tasks.map(task=>task.key)});evidenceRowsSeen.push(...rows.map(row=>({...row})));return{scopeKey,rows};}
                  });
                  await controller.beforeRequest();controller.mountControls(document.querySelector('#settings'));
                  document.querySelector('#host').focus();
                }''', owner)

                root = page.locator('[data-source-tracking-controls]')
                root.wait_for()
                tag = f'{owner}/{width}'
                check(tag + ' history keeps the source owner', root.get_attribute('data-source-tracking-controls') == owner)
                check(tag + ' no automatic mode selector is exposed', page.locator('[data-source-tracking-controls] select').count() == 0)
                check(tag + ' beforeRequest leaves source history unobserved', page.locator('.ms-source-event').count() == 0 and page.evaluate('collects===0 && evidenceReads.length===0'))
                check(tag + ' no consent modal or floating dock is created', page.locator('#memorySuiteSourceReview, [x-memory-suite-source-review-dock]').count() == 0)
                check(tag + ' beforeRequest performs no prompt, execution, or source-storage write', page.evaluate('prompts===0 && executions.length===0 && collects===0 && storage.size===0'))
                check(tag + ' host focus remains available', page.locator('#host').evaluate('node=>node===document.activeElement'))

                geometry = root.evaluate('''node=>{const box=node.getBoundingClientRect();return{x:box.left,right:box.right,scroll:node.scrollWidth,client:node.clientWidth,parentScroll:node.parentElement.scrollWidth,parentClient:node.parentElement.clientWidth}}''')
                check(tag + ' inline explicit-review controls fit the viewport', geometry['x'] >= 0 and geometry['right'] <= width + 1 and geometry['scroll'] <= geometry['client'] + 1 and geometry['parentScroll'] <= geometry['parentClient'] + 1, geometry)

                # Request-boundary admission is deliberately inert. End the
                # synthetic request before the read-only explicit view action.
                page.evaluate('controller.afterRequest()')
                root.get_by_role('button', name='원문 구간 조회').click()
                page.wait_for_function('collects===1')
                check(tag + ' explicit source view reads the current owner once without creating durable history', page.locator('.ms-source-event').count() == 2 and page.evaluate('collects===1 && prompts===0 && executions.length===0 && evidenceReads.length===0 && storage.size===0 && controller.status().events.length===0'))
                check(tag + ' read-only source view leaves comparison evidence unrequested', page.locator('.ms-source-history pre').count() == 0 and page.evaluate('window.xss===0'))
                check(tag + ' explicit source view preserves owner scope and current unit identities', page.evaluate('''owner=>{const state=controller.status();return state.scopeKey==='scope-'+owner&&state.events.length===0&&state.tasks.length===2&&state.tasks.map(task=>task.key).join(',')==='32,33'&&state.tasks.every(task=>task.protectionOnly)}''', owner))

                if width in [1440, 390]:
                    page.screenshot(path=str(E / f'{owner}_{width}.png'))
                page.evaluate('controller.dispose()')
                page.close()
        browser.close()
except Exception as error:
    errors.append(str(error))
    raise
finally:
    payload = {'test': 'source_review_browser', 'environment': 'real Chromium DOM and shared controller; synthetic owner source evidence',
               'passed': sum(result['ok'] for result in results), 'total': len(results), 'errors': errors, 'results': results}
    (E / 'RESULTS.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(json.dumps({key: value for key, value in payload.items() if key != 'results'}, ensure_ascii=False))
