/**
 * export-assembler-v2
 *
 * 基于 Canonical（config-core 解释体）导出 V2 标准的 pipeline_assembler.config：
 * - 严格：不做家族推测与兜底；缺失关键信息直接报错（Fail Fast）
 * - 标准化：compatibility 一律容器形式 { type:'compatibility', config:{ moduleType, moduleConfig?, providerType } }
 * - provider 一律 openai 模块，配置中携带 { providerType, model, baseUrl?, auth? }
 */
export declare function exportAssemblerConfigV2(canonical: any): {
    config: {
        pipelines: {
            id: string;
            provider: {
                type: string;
            };
            modules: {
                provider: {
                    type: string;
                    config: any;
                };
                compatibility: any;
                llmSwitch: {
                    type: any;
                    config: any;
                };
                workflow: {
                    type: any;
                    config: any;
                    enabled: boolean;
                } | {
                    type: string;
                    config: {};
                    enabled?: undefined;
                };
            };
            settings: any;
        }[];
        routePools: Record<string, string[]>;
        routeMeta: any;
        authMappings: Record<string, string>;
    };
};
