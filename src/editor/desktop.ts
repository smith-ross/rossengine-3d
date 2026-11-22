// Present when the editor runs inside RossEngine Studio (Electron); see electron/studio-preload.cjs.
export interface StudioBridge {
  isDesktop: true
  info(): Promise<{ version: string; platform: string; template: boolean; buildDir: string }>
  open(): Promise<{ token: string; name: string; text: string } | null>
  save(token: string, text: string): Promise<{ token: string; name: string }>
  saveAs(suggestedName: string, text: string): Promise<{ token: string; name: string } | null>
  chooseBuildDir(): Promise<string | null>
  build(o: { name: string; placeJson: string; outDir?: string }): Promise<{ ok: boolean; dir?: string; exe?: string; error?: string }>
  reveal(path: string): Promise<void>
  runGame(path: string): Promise<boolean>
  setDirty(dirty: boolean): void
  closeNow(): void
  onMenu(cb: (id: string) => void): () => void
}

export const desktop: StudioBridge | undefined = (globalThis as any).rossStudio
