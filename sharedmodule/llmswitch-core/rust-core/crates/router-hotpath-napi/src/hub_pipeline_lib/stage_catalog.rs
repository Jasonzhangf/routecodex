use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HubPipelineStageId {
    NormalizeRequest,
    ReqInboundFormatParse,
    ReqInboundSemanticLift,
    ReqInboundContextCapture,
    ReqProcessToolGovernance,
    ReqProcessRouteSelect,
    ReqOutboundContextMerge,
    ReqOutboundFormatBuild,
    ReqOutboundCompat,
    RespInboundSseDecode,
    RespInboundFormatParse,
    RespProcessToolGovernance,
    RespProcessFinalize,
    RespOutboundClientRemap,
    RespOutboundSseStream,
    EffectPlan,
}
