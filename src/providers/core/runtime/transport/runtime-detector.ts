export class RuntimeDetector {
  private providerType: string;

  constructor(
    _config: { config: { providerId?: string } },
    providerType: string,
    _oauthProviderId?: string
  ) {
    this.providerType = providerType;
  }

  isGeminiFamily(): boolean {
    const providerType = this.providerType.toLowerCase();
    return providerType === 'gemini';
  }
}
