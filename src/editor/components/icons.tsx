// Class icons for the explorer and menus.
import {
  Archive, Box, Boxes, Braces, Clock, FileCode2, Flashlight, Folder, FolderCode, Globe, Image, LayoutTemplate,
  Lightbulb, Link, List, LucideIcon, MapPin, Monitor, Mouse, MousePointerClick, Music, Package, PersonStanding,
  Pointer, Shield, Sparkles, Square, SquareDashed, SquareFunction, Sticker, TextCursorInput, Triangle, Type, User,
  UserRound, Users, Variable, Video, Volume2, Waves, Zap, Shapes, Layers, Move, Image as ImageIcon, Film, Clapperboard, Grid3x3,
  Square as SquareIcon, Scan, Paintbrush, Aperture, Footprints,
} from 'lucide-react'

const ICONS: Record<string, [LucideIcon, string]> = {
  Workspace: [Globe, '#5aa9ff'], Players: [Users, '#8fd17f'], Lighting: [Lightbulb, '#ffd54a'], ScriptService: [FileCode2, '#7fd17f'],
  Storage: [Archive, '#7fb3ff'], StarterGui: [LayoutTemplate, '#b48cff'], StarterPlayer: [UserRound, '#8fd17f'],
  StarterCharacterScripts: [FolderCode, '#8fd17f'], SoundService: [Volume2, '#c0c4cc'],
  Part: [Box, '#aeb6c4'], MeshPart: [Shapes, '#e79a5a'], WedgePart: [Triangle, '#aeb6c4'], SpawnLocation: [MapPin, '#7fd17f'],
  Model: [Package, '#e7b85a'], Folder: [Folder, '#e7c46a'], Script: [FileCode2, '#7fd17f'], ModuleScript: [Braces, '#c98fff'],
  Camera: [Video, '#c0c4cc'], Humanoid: [PersonStanding, '#ffd54a'], Player: [User, '#8fd17f'], PlayerGui: [Monitor, '#b48cff'],
  Mouse: [Mouse, '#c0c4cc'], ScreenGui: [Monitor, '#b48cff'], Frame: [Square, '#b48cff'], TextLabel: [Type, '#b48cff'],
  TextButton: [MousePointerClick, '#b48cff'], TextBox: [TextCursorInput, '#b48cff'], ImageLabel: [Image, '#b48cff'],
  ImageButton: [Image, '#b48cff'], UICorner: [SquareDashed, '#b48cff'], UIStroke: [SquareDashed, '#b48cff'],
  UIListLayout: [List, '#b48cff'], PointLight: [Lightbulb, '#ffd54a'], SpotLight: [Flashlight, '#ffd54a'], Sound: [Music, '#5ad1c9'],
  ClickDetector: [Pointer, '#c0c4cc'], WeldConstraint: [Link, '#c0c4cc'], BindableEvent: [Zap, '#ff9a8a'],
  Shader: [Paintbrush, '#ff7ac6'], ScreenShader: [Aperture, '#ff7ac6'], AnimationPlayer: [Clapperboard, '#ffb85a'], Animation: [Film, '#ffb85a'], Skeleton: [PersonStanding, '#c9a0ff'], CharacterBody3D: [Footprints, '#5fa0ff'], Bone: [Link, '#c9a0ff'],
  BindableFunction: [SquareFunction, '#ff9a8a'], ForceField: [Shield, '#7fcfff'], Decal: [Sticker, '#e79a5a'],
  Tween: [Waves, '#c0c4cc'], InputObject: [Pointer, '#c0c4cc'],
  World2D: [Layers, '#5ad1c9'], Node2D: [Move, '#5ad1c9'], Sprite2D: [ImageIcon, '#5ad1c9'], AnimatedSprite2D: [Film, '#5ad1c9'],
  SpriteAnimation: [Clapperboard, '#5ad1c9'], TileTerrain: [Grid3x3, '#57c26a'], TileMap: [Grid3x3, '#e7b85a'], Camera2D: [Video, '#5ad1c9'], Text2D: [Type, '#5ad1c9'],
  ParticleEmitter: [Sparkles, '#ffb44a'], ParticleEmitter2D: [Sparkles, '#5ad1c9'],
  StaticBody2D: [SquareIcon, '#4adf7a'], RigidBody2D: [Box, '#4adf7a'], CharacterBody2D: [PersonStanding, '#4adf7a'], Area2D: [Scan, '#ffc04a'],
}

export function iconFor(cls: string): [LucideIcon, string] {
  if (ICONS[cls]) return ICONS[cls]
  if (cls.endsWith('Value')) return [Variable, '#7fb3ff']
  if (cls.endsWith('Service')) return [Boxes, '#c0c4cc']
  if (cls === 'Clock') return [Clock, '#c0c4cc']
  return [Sparkles, '#9aa0aa']
}

const LANG_BADGE: Record<string, [string, string]> = { TypeScript: ['TS', '#3b8eea'], Python: ['PY', '#e8b923'] }

export function ClassIcon({ cls, size = 14, lang }: { cls: string; size?: number; lang?: string }) {
  if (lang && LANG_BADGE[lang] && (cls === 'Script' || cls === 'ModuleScript')) {
    const [text, color] = LANG_BADGE[lang]
    return <span className={`lang-badge${cls === 'ModuleScript' ? ' module' : ''}`} style={{ background: color }} title={`${lang} ${cls}`}>{text}</span>
  }
  const [Icon, color] = iconFor(cls)
  return <Icon className="class-icon" size={size} color={color} strokeWidth={2} />
}
