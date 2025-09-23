/**
 * Type declarations for external modules
 */

declare module 'open' {
  export function open(url: string): Promise<void>;
  export function open(url: string, options?: { app?: string }): Promise<void>;
}