'use strict';
// Synthetic response for source/consent tests. It changes only the output contract;
// original U+A, fault injection and all storage/adoption assertions remain real.
module.exports=(quote,ref='t1-a',name='Alice')=>({schema:'libra.canonical_artifact.v4',entities:[{tempId:'person',name,type:'person',kind:'person',evidenceSpans:[{ref,quote}]}],facts:[{tempFactId:'event',domain:'event',subjectTempRef:'person',claimKind:'event',values:{detail:quote},text:quote,temporalRole:'current_sequence',certainty:'confirmed',evidenceSpans:[{ref,quote}]}],stateBindings:[]});
