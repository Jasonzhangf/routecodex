export interface StageRecorder {
  record(stage: string, payload: object): void;
}
