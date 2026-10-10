'use strict';
// Actual SDK owner-operation admission, not an extracted legacy orchestration fragment.
// Accepted nested I/O drains before global prepare; later writes are covered by the
// companion storage_global_transition_real_handler_test.cjs.
require('./storage_global_allchat_nested_writer_test.cjs');
