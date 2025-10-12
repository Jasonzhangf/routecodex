// Temporary shim so TypeScript can compile while pipeline-core is extracted
declare module '@routecodex/pipeline-core' {
  export const AnthropicOpenAIConverter: any;
  export const PipelineManager: any;
  export const PipelineAssembler: any;
}

