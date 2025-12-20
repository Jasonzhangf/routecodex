type ModuleInfo = {
  id: string;
  name: string;
  version: string;
  description: string;
  type?: string;
};

export class BaseModule {
  private readonly info: ModuleInfo;

  constructor(info: ModuleInfo) {
    this.info = info;
  }

  getModuleInfo(): ModuleInfo {
    return this.info;
  }

  getInfo(): ModuleInfo {
    return this.info;
  }

  isInitialized(): boolean {
    return true;
  }

  isRunning(): boolean {
    return true;
  }
}
