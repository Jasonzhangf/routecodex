export type ModuleInfo = {
  id: string;
  name: string;
  version?: string;
  type?: string;
  description?: string;
};

export class BaseModule {
  private _info: ModuleInfo;
  constructor(info: ModuleInfo) {
    this._info = info;
  }
  public getInfo(): ModuleInfo {
    return this._info;
  }
  public isRunning(): boolean { return true; }
}

export default BaseModule;

