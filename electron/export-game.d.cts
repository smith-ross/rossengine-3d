export declare function exportGame(o: { templateDir: string; outRoot: string; name: string; placeJson: string; platform?: string; arch?: string }): { dir: string; exe: string }
export declare function safeName(name: string): string
export declare const PLAYER_NAME: string
export declare function exportGameFromRuntime(o: { studioDir: string; studioExe: string; playerAsar: string; outRoot: string; name: string; placeJson: string }): { dir: string; exe: string }
