import type { AiProvider } from '@foliux-pdf/core';
import type { AiAssistant } from './ai';

/** Reparte cada petición al servicio de IA elegido en los ajustes en ese momento (Claude o Gemini). */
export class AiRouter implements AiAssistant {
  constructor(
    private readonly getProvider: () => Promise<AiProvider>,
    private readonly services: Record<AiProvider, AiAssistant>,
  ) {}

  private async current(): Promise<AiAssistant> {
    return this.services[await this.getProvider()];
  }

  async chat(input: Parameters<AiAssistant['chat']>[0]) {
    return (await this.current()).chat(input);
  }
  async extractTables(input: Parameters<AiAssistant['extractTables']>[0]) {
    return (await this.current()).extractTables(input);
  }
  async detectFields(input: Parameters<AiAssistant['detectFields']>[0]) {
    return (await this.current()).detectFields(input);
  }
  async findSensitive(input: Parameters<AiAssistant['findSensitive']>[0]) {
    return (await this.current()).findSensitive(input);
  }
  async makeSlides(input: Parameters<AiAssistant['makeSlides']>[0]) {
    return (await this.current()).makeSlides(input);
  }
  async audioSummary(input: Parameters<AiAssistant['audioSummary']>[0]) {
    return (await this.current()).audioSummary(input);
  }
}
