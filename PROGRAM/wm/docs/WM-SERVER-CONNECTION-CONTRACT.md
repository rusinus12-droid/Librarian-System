# WM saved server connection and connection-only bootstrap

This is the approved server-storage plan's B6 connection/configuration path. It is not server-mode activation, data migration, or a replacement for NativeHostGate.

## Default runtime

A normal live plugin with no injected storage router constructs `WmServerConnection.createWmServerConnection` with existing `RisuCompat.pluginStorage` and the runtime's bound standard browser `fetch`. Detached execution and existing injected routers keep their previous paths. Opening the plugin or settings, saving settings, and reopening the plugin do not make a server request.

The storage panel saves an existing WM-only capability credential and bare server origin in exact private local root `wm.server-connection.v1`, with verified readback. Saving a credential is explicitly labeled. The host's plugin storage is not represented as an encrypted vault. A blank credential retains the saved one only for the same normalized origin; changing origins clears it. The password field is never populated from stored data. Clear removes saved credential content without changing authoritative storage mode. No credential, permission, server process, native authority, or backend identity is issued.

The exact connection root and its currently owned compatibility chunks are excluded from memory inventory/export. Unknown/stale chunks retain the existing completeness failure. Portable settings and diagnostic exports have no access to this root. The public controller view carries only origin, configured/credential-present flags, transport availability and an in-process settings revision. Error text is sanitized; arbitrary HTTP bodies and fetch exception messages are never returned.

## Explicit check

The user must separately choose “서버 연결 확인”. The only requests are authenticated GET `/v1/wm/capabilities` and GET `/v1/wm/dataset/status`, with `X-Memory-Suite-Plugin: libra_world_manager` and the already-supplied WM Bearer credential. There are no memory bodies, snapshot operations, writes, or upload/migration actions. The local token payload check rejects administrator/other-owner credentials before transport; only the server verifies the credential signature.

Accept HTTPS origins or HTTP loopback (`localhost`, `127.0.0.1`, `[::1]`). Reject embedded userinfo, path, query, fragment, and non-loopback plaintext HTTP. Standard fetch uses `redirect:error`, `credentials:omit`, `cache:no-store`, and `referrerPolicy:no-referrer`; there is no native-fetch/proxy fallback with unknown redirect guarantees. Existing browser CORS/mixed-content/security restrictions still apply. A supported browser streaming Response is required. Live RisuAI/browser/platform connectivity has not been qualified by offline tests.

Both metadata responses are limited while streaming to 128 KiB; excess data is cancelled. The complete check times out after 10 seconds. These are metadata-check safety boundaries, not new limits on WM memory or data. Protocol/capability/status fields and initialized dataset identity/route/health are checked. Public success returns only `ok`, backend ID, protocol, and the three documented capacity values. A successful check certifies neither native all-writer ownership nor a valid server writer route. Configuration changes/disposal invalidate in-flight reads/checks; the UI invalidates stale connection success on save, clear, changed persisted config or failed config read. These ordinary settings readbacks are not cross-executor CAS.

## Activation remains unsupported on the stock host

The original approved design §7.3 and implementation plan's blocker section already require native all-writer fencing, durable route CAS and restart qualification for real server-mode activation, in addition to safe whole-data migration. This condition is not introduced by the stronger later GRADIA profile.

`WmNativeHostGate.qualifiedProductionProfiles` remains empty. `check({route})` still rejects `server_only` without a supported native provider. `WmStorageRouter` still checks that gate on server requests and rejects server-only without it. Ordinary pluginStorage get/set/readback does not satisfy these guarantees; manually selecting an empty server dataset would not create a qualified route or fence older writers.

The full injectable server backend additionally requires trusted identity, route, writer epoch, incarnation, operation journal and authenticated transport metadata. Ordinary HTTP capabilities/status do not provide a trusted incarnation. This repair deliberately constructs no full writer backend or storage router and makes no such metadata up. The default server also keeps external source-fence migration and handoff activation opt-ins closed.

Thus existing plugin-only usage and explicit connection checking are the currently usable default paths. No already-approved stock-host ordinary server activation path was found that works without the missing authority contract. RisuAI core changes, weaker/exclusive-writer mode contracts, credential provisioning, actual DATA operations, and release/deployment are not part of this repair. Full/Min publication and later actual-host checks are separate stages.
