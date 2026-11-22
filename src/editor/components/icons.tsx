// Small glyph-based class icons for the explorer.
const ICONS: Record<string, [string, string]> = {
  Workspace: ['🌐', '#5aa9ff'], Players: ['👥', '#9fd36a'], Lighting: ['💡', '#ffd54a'], ReplicatedStorage: ['📦', '#7fb3ff'],
  ServerScriptService: ['🗄', '#7cc'], ServerStorage: ['🗃', '#aaa'], StarterGui: ['🖼', '#b48cff'], StarterPlayer: ['🧍', '#9fd36a'],
  StarterPlayerScripts: ['📁', '#9fd36a'], StarterCharacterScripts: ['📁', '#9fd36a'], SoundService: ['🔊', '#ccc'],
  Part: ['■', '#b0b6c2'], WedgePart: ['◣', '#b0b6c2'], SpawnLocation: ['⊕', '#8fd18f'], Model: ['◈', '#e7b85a'], Folder: ['📁', '#e7c46a'],
  Script: ['📜', '#7fd17f'], LocalScript: ['📜', '#6fb6ff'], ModuleScript: ['📜', '#d38fff'], Camera: ['🎥', '#ccc'],
  Humanoid: ['🙂', '#ffd54a'], Player: ['🧍', '#9fd36a'], ScreenGui: ['▭', '#b48cff'], Frame: ['▢', '#b48cff'],
  TextLabel: ['T', '#b48cff'], TextButton: ['⏺', '#b48cff'], TextBox: ['⌨', '#b48cff'], ImageLabel: ['🖼', '#b48cff'],
  ImageButton: ['🖼', '#b48cff'], UICorner: ['◜', '#b48cff'], UIStroke: ['▣', '#b48cff'], UIListLayout: ['☰', '#b48cff'],
  PointLight: ['✺', '#ffd54a'], SpotLight: ['⚡', '#ffd54a'], Sound: ['♪', '#ccc'], ClickDetector: ['👆', '#ccc'],
  WeldConstraint: ['⛓', '#ccc'], BindableEvent: ['⚑', '#f99'], BindableFunction: ['ƒ', '#f99'], RemoteEvent: ['⚑', '#fc6'],
  RemoteFunction: ['ƒ', '#fc6'], ForceField: ['◌', '#7cf'],
}

export function ClassIcon({ cls }: { cls: string }) {
  let [glyph, color] = ICONS[cls] ?? ['•', '#999']
  if (cls.endsWith('Value')) [glyph, color] = ['▤', '#9cf']
  return <span className="class-icon" style={{ color }}>{glyph}</span>
}
