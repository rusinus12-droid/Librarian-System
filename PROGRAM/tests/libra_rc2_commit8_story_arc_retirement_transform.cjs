'use strict';

module.exports = (source, { replaceExactlyOnce }) => {
  const labels = [];
  const rep = (label, find, replace) => {
    source = replaceExactlyOnce(source, find, replace, label);
    labels.push(label);
  };

  const legacyBuilderStart = source.indexOf('  const buildLibraStoryArcPanelLegacy0316 =');
  const recallViewerStart = source.indexOf('  const buildLibraRecallViewerPanel =', legacyBuilderStart);
  if (legacyBuilderStart < 0 || recallViewerStart <= legacyBuilderStart) throw new Error('legacy_story_arc_gui_region_missing');
  rep(
    'legacy_story_arc_gui_to_shared_adapter',
    source.slice(legacyBuilderStart, recallViewerStart),
`  const buildLibraStoryArcPanel = () => buildWorldManagerNarrativePanel();

`
  );

  rep('legacy_gradia_story_arc_registry',
`  Object.freeze({ id: 'story_arc', group: 'materials', label: '서사 방향', icon: '◎', description: '서사 연속성과 비강제 방향' }),
`,
``);

  rep('legacy_gradia_story_arc_routes',
`    if (requested === 'story_arc_current') return { pageId: 'story_arc', storyArcHubSection: 'current' };
    if (requested === 'story_arc_direction') return { pageId: 'story_arc', storyArcHubSection: 'direction' };
    if (requested === 'story_arc_advanced') return { pageId: 'story_arc', storyArcHubSection: 'advanced' };
`,
``);

  rep('legacy_gradia_story_arc_renderer',
`  else if (pageId === 'story_arc') child = buildLibraStoryArcPanel();
`,
``);

  rep('legacy_gradia_story_arc_sidebar_children',
`    story_arc: [
      { id: 'story_arc_current', label: '현재 내러티브', active: () => Gui.storyArcHubSection === 'current' },
      { id: 'story_arc_direction', label: '방향 설정', active: () => Gui.storyArcHubSection === 'direction' },
      { id: 'story_arc_advanced', label: '고급 · 진단', active: () => Gui.storyArcHubSection === 'advanced' }
    ],
`,
``);

  const retireHelperStart = source.indexOf('function __libraCompletionRetireStoryArcDom(root) {');
  const installerStart = source.indexOf('function __libraCompletionInstallPublicApi() {', retireHelperStart);
  if (retireHelperStart < 0 || installerStart <= retireHelperStart) throw new Error('story_arc_dom_retire_helper_region_missing');
  rep('story_arc_dom_retire_helper', source.slice(retireHelperStart, installerStart), '');

  rep('story_arc_dom_observer_install',
`    try {
        if(typeof document!=='undefined'){
            __libraCompletionRetireStoryArcDom(document);
            new MutationObserver(list=>list.forEach(m=>m.addedNodes.forEach(n=>__libraCompletionRetireStoryArcDom(n)))).observe(document.documentElement||document.body,{childList:true,subtree:true});
        }
    } catch (_) {}
`,
``);

  return { source, labels };
};
