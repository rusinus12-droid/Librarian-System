const {create,pause}=require('/tmp/claude-0/-home-user-Librarian-System/ddcf12e5-0b97-597a-899d-2ac9c82e06a7/scratchpad/a2/PROGRAM/tests/fixtures/libra_gui_memory_dom_host.cjs');
(async()=>{const s=await create('LIBRA','Full',{});await s.open();await pause(400);
console.log('dialog',!!s.doc.querySelector('[data-libra-quick-dialog]'));
console.log([...s.doc.querySelectorAll('.sidebar [data-go]')].map(n=>n.dataset.go).join(','));
await s.click('.sidebar [data-go="settings"]');
console.log([...s.doc.querySelectorAll('.setnav [data-subtab]')].map(n=>n.dataset.subtab).join(','), !!s.doc.querySelector('[data-product-settings-section]'));
console.log([...s.doc.querySelectorAll('[data-product-settings-section] nav.tabs button')].map(n=>n.textContent));
console.log(s.doc.querySelector('[data-libra-quick-dialog]')?.outerHTML.slice(0,600));
await s.close();process.exit(0)})()
