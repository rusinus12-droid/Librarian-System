# Client connection-probe status publication

A delayed connection probe could overwrite a newer successful bootstrap's `connected` status with `unavailable`. The probe's authority rejection was correct; publication of that obsolete failure was not. A second reproduced interleaving delivered an older transport failure after a newer bootstrap succeeded.

Both StorageSDK variants now publish failed-probe status only while the probe, bootstrap, binding generation, configured URL and lifecycle remain current. Checks occur before and after the asynchronous URL read. Explicit stale errors do not publish unavailable. Genuine current failures still do.

This changes only client status publication. Bootstrap/data binding, probe return values, stored modes, retries, timeouts, server behavior and permissions are unchanged. Public per-attempt return values still describe the individual attempt. The companion panel-currentness integration also suppresses obsolete result display after a newer probe/bootstrap, URL/mode/range change (including ABA), panel detachment, or lifecycle disposal. See SDK_PROBE_UI_CURRENTNESS_20261005.md. This is not confirmation of a historical live disconnection or a full-product dashboard acceptance.

The synthetic public bridge regression uses a fake transport and deferred promises, with no actual network, server, credentials or persistent user storage. The unchanged-source race fails before the patch; both SDK variants pass stale-success, late-failure and genuine-failure cases afterward. Distribution-source verification separately binds extracted embedded factory bytes from all five Full and Min artifacts; this is factory execution rather than whole-plugin host/UI acceptance. Server and full-product acceptance are not run.
