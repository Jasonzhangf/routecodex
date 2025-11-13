export function exportAssemblerConfig(canonical) {
    const rawPipes = Array.isArray(canonical?.pipelines) ? canonical.pipelines : [];
    // Ensure required modules exist: workflow is required by PipelineManager
    const pipelines = rawPipes.map((p) => {
        const pl = JSON.parse(JSON.stringify(p || {}));
        pl.modules = pl.modules || {};
        if (!pl.modules.workflow) {
            pl.modules.workflow = { type: 'streaming-control', config: {} };
        }
        return pl;
    });
    const routePools = canonical?.routing || {};
    const routeMeta = canonical?.routeMeta || {};
    return {
        config: {
            pipelines,
            routePools,
            routeMeta,
            authMappings: {},
        }
    };
}
//# sourceMappingURL=export-assembler.js.map