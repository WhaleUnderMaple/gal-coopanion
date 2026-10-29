/**
 * cortico-world-gal -- visual-novel companion world for Coopanion.
 *
 * Three things in one plugin:
 *   1. text    : reads a local bridge (bridge/luna-bridge.py) that speaks to LunaTranslator
 *   2. picture : grabs the game window (print-window, works minimized & occluded), diffs it
 *                against the previous frame and only pushes what changed
 *   3. action  : clicks "next" with PostMessage, so it never steals the user's focus
 *
 * All paths are configurable; nothing here assumes a particular user or install layout.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ToolDef, World, WorldHost } from 'cortico/core/types.ts'
import type { WorldDefinition } from 'cortico/world.ts'

export interface GalConfig {
  enabled: boolean
  /** HTTP endpoint of the bridge (see bridge/luna-bridge.py) */
  bridgeUrl: string
  /** Process name of the game (empty -> read from targetFile) */
  process: string
  /** Where "currently selected game" is remembered */
  targetFile: string
  /** Folder that holds capture-window.ps1 / advance.ps1 / list-games.ps1 */
  scriptsDir: string
  /** Optional: path to ffmpeg.exe. Empty -> auto-detect from PATH. */
  ffmpegPath: string
  /** How often to look at the window (seconds) */
  everySec: number
  /** Push only the changed region */
  diffMode: boolean
  /** Difference threshold for ffmpeg bbox */
  diffMinVal: number
  /** Push the whole frame instead of a crop when the change covers this share of the frame */
  bigChangeRatio: number
  /** Downscale push images to this width (0 = keep) */
  maxWidth: number
  /** Automatic picture pushes (off = only on gal_peek) */
  pushImage: boolean
  maxPushesPerHour: number
}

export const DEFAULT_CONFIG: GalConfig = {
  enabled: true,
  bridgeUrl: 'http://127.0.0.1:18996',
  process: '',
  targetFile: 'gal-target.json',
  scriptsDir: 'scripts',
  ffmpegPath: '',
  everySec: 8,
  diffMode: true,
  diffMinVal: 25,
  bigChangeRatio: 0.35,
  maxWidth: 1280,
  pushImage: true,
  maxPushesPerHour: 120,
}

const SOURCE = 'gal'

interface Line { seq: number; name: string | null; text: string; ts: number }
interface Region { w: number; h: number; x: number; y: number }

const fmt = (l: Line): string => `${l.name ? l.name + '：' : ''}${(l.text || '').replace(/\n+/g, ' ').trim()}`

function run(exe: string, args: string[], timeoutMs: number, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve(String(stdout ?? '') + String(stderr ?? '') + (err ? String(err) : '')))
  })
}

function pngSize(bytes: Uint8Array): { w: number; h: number } {
  if (bytes.length < 24) return { w: 0, h: 0 }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { w: dv.getUint32(16), h: dv.getUint32(20) }
}

export class GalWorld implements World {
  readonly id = 'gal'
  readonly label = 'Visual novel companion'

  private host: WorldHost | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private lastSeq = 0
  private lastFrame: Uint8Array | null = null
  private lastPushAt = 0
  private pushesThisHour = 0
  private hourMark = 0
  private lastNote = ''
  private lastError = ''
  private ffmpeg = ''

  constructor(private readonly options: { cfg: GalConfig; dataDir: string }) {}

  private get cfg(): GalConfig { return this.options.cfg }

  private base(): string { return this.cfg.bridgeUrl.replace(/\/+$/, '') }

  private script(name: string): string {
    return join(this.cfg.scriptsDir, name)
  }

  private targetPath(): string {
    const f = this.cfg.targetFile
    return f.includes('\\') || f.includes('/') ? f : join(this.options.dataDir, f)
  }

  private targetProcess(): string {
    const fixed = (this.cfg.process ?? '').trim()
    if (fixed) return fixed
    try {
      return String((JSON.parse(readFileSync(this.targetPath(), 'utf8')) as { process?: string })?.process ?? '').trim()
    } catch {
      return ''
    }
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host
    if (!this.cfg.enabled) return
    const period = Math.max(2000, Math.round(this.cfg.everySec) * 1000)
    this.timer = setInterval(() => void this.tick(), period)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    host.log.info(`gal: text ${this.base()}; picture every ${this.cfg.everySec}s for ${this.targetProcess() || '(no game selected yet)'}`)
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.lastFrame = null
    this.host = null
  }

  envPromptVars(): Record<string, string> { return {} }
  envPrompt(): string { return '' }

  // ---------- text ----------
  private async get(path: string, params: Record<string, string | number | undefined> = {}): Promise<any> {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
    const res = await fetch(`${this.base()}${path}${qs.toString() ? '?' + qs.toString() : ''}`, { signal: AbortSignal.timeout(150_000) })
    const raw = await res.text()
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`bridge did not return JSON: ${raw.slice(0, 120)}`)
    }
  }

  // ---------- picture ----------
  private resolveFfmpeg(): string {
    if (this.ffmpeg) return this.ffmpeg
    const configured = (this.cfg.ffmpegPath ?? '').trim()
    if (configured && existsSync(configured)) { this.ffmpeg = configured; return this.ffmpeg }
    for (const p of ['ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe']) {
      if (p === 'ffmpeg.exe' || existsSync(p)) { this.ffmpeg = p; return this.ffmpeg }
    }
    this.ffmpeg = 'ffmpeg'
    return this.ffmpeg
  }

  private async capture(file: string): Promise<boolean> {
    const proc = this.targetProcess()
    if (!proc) { this.lastError = 'no game selected'; return false }
    const out = await run('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script('capture-window.ps1')], 40_000,
      { GAL_PROC: proc, GAL_OUT: file })
    if (out.includes('OK') && existsSync(file)) return true
    const code = /NOPROC|BADSIZE|PRINTFAIL/.exec(out)?.[0] ?? 'UNKNOWN'
    const size = /(\d+x\d+)/.exec(out)?.[1] ?? ''
    this.lastError = `capture failed (${code}${size ? ' ' + size : ''})`
    return false
  }

  private async diffRegion(prev: string, cur: string, work: string): Promise<Region | null> {
    const ff = this.resolveFfmpeg()
    const diff = work + '-diff.png'
    await run(ff, ['-y', '-i', prev, '-i', cur, '-filter_complex',
      '[0][1]blend=all_mode=difference,format=gray', '-frames:v', '1', diff], 30_000)
    if (!existsSync(diff)) return null
    const log = await run(ff, ['-y', '-i', diff, '-vf', `bbox=min_val=${Math.max(1, this.cfg.diffMinVal)}`, '-f', 'null', '-'], 30_000)
    const m = /crop=(\d+):(\d+):(\d+):(\d+)/.exec(log)
    if (!m) return null
    const region = { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) }
    return region.w >= 12 && region.h >= 12 ? region : null
  }

  private async crop(src: string, out: string, r: Region): Promise<boolean> {
    const pad = 24
    const x = Math.max(0, r.x - pad)
    const y = Math.max(0, r.y - pad)
    const w = r.w + pad * 2
    const h = r.h + pad * 2
    const scale = this.cfg.maxWidth > 0 ? `,scale=${this.cfg.maxWidth}:-2` : ''
    await run(this.resolveFfmpeg(), ['-y', '-i', src, '-vf', `crop=${w}:${h}:${x}:${y}${scale}`, '-frames:v', '1', out], 30_000)
    return existsSync(out)
  }

  private async push(bytes: Uint8Array, note: string, kind: string): Promise<void> {
    const host = this.host
    if (!host) return
    this.lastPushAt = Date.now()
    this.pushesThisHour++
    this.lastNote = note
    try {
      await host.pushEvent({
        type: 'gal.picture',
        ts: new Date().toISOString(),
        source: SOURCE,
        origin: 'external',
        senderKey: SOURCE,
        text: `Game screen changed: ${note}. The image is the changed part — look at it yourself.`,
        blobs: [{ bytes, mime: 'image/png', name: 'gal-change.png', fallbackText: '[game screen]' }],
        meta: { kind, note },
      })
    } catch (err) {
      host.log.warn(`gal: push failed ${String(err)}`)
    }
  }

  private async look(diff: boolean): Promise<{ bytes: Uint8Array; note: string } | null> {
    const dir = join(tmpdir(), 'gal-' + randomUUID())
    try {
      mkdirSync(dir, { recursive: true })
      const cur = join(dir, 'cur.png')
      if (!await this.capture(cur)) return null
      const bytes = await readFile(cur)
      if (!bytes?.length) return null
      if (!diff || !this.cfg.diffMode) { this.lastFrame = bytes; return { bytes, note: 'full frame' } }
      if (!this.lastFrame?.length) { this.lastFrame = bytes; return { bytes, note: 'full frame (first)' } }
      const a = pngSize(this.lastFrame)
      const b = pngSize(bytes)
      const prevFile = join(dir, 'prev.png')
      writeFileSync(prevFile, this.lastFrame)
      this.lastFrame = bytes
      if (a.w !== b.w || a.h !== b.h) return { bytes, note: `frame changed size (${a.w}x${a.h} -> ${b.w}x${b.h})` }
      const region = await this.diffRegion(prevFile, cur, join(dir, 'w'))
      if (!region) return null
      const frameArea = Math.max(1, b.w * b.h)
      if ((region.w * region.h) / frameArea >= this.cfg.bigChangeRatio) {
        return { bytes, note: 'full frame (big change: new scene / CG)' }
      }
      const out = join(dir, 'crop.png')
      if (!await this.crop(cur, out, region)) return { bytes, note: 'full frame (crop failed)' }
      const cropped = await readFile(out)
      if (!cropped?.length) return { bytes, note: 'full frame (empty crop)' }
      return { bytes: cropped, note: `changed region ${region.w}x${region.h}` }
    } catch (e) {
      this.lastError = String(e).slice(0, 200)
      return null
    }
  }

  private async tick(): Promise<void> {
    if (this.busy || !this.cfg.pushImage) return
    if (!this.targetProcess()) return
    const hour = Math.floor(Date.now() / 3_600_000)
    if (hour !== this.hourMark) { this.hourMark = hour; this.pushesThisHour = 0 }
    if (this.pushesThisHour > this.cfg.maxPushesPerHour) return
    this.busy = true
    try {
      const shot = await this.look(true)
      if (shot) await this.push(shot.bytes, shot.note, 'change')
    } finally {
      this.busy = false
    }
  }

  /** Start LunaTranslator if the game is running but the bridge cannot reach it. */
  private async ensureLuna(): Promise<string> {
    const up = async (): Promise<boolean> => {
      try {
        const port = new URL(this.base()).port || '2333'
        const res = await fetch(`http://127.0.0.1:${port}/api/list/translator`, { signal: AbortSignal.timeout(1500) })
        return res.ok
      } catch { return false }
    }
    if (await up()) return 'LunaTranslator is reachable'
    const exe = (this.cfg as unknown as { lunaExe?: string }).lunaExe ?? ''
    const proc = this.targetProcess()
    if (!proc) return 'no game selected yet'
    const tasks = await run('tasklist.exe', ['/FI', `IMAGENAME eq ${proc}.exe`, '/NH'], 8000)
    if (!tasks.toLowerCase().includes(`${proc.toLowerCase()}.exe`)) return 'game is not running'
    if (!exe || !existsSync(exe)) return 'LunaTranslator is not running (set lunaExe to auto-start it)'
    try {
      const { spawn } = await import('node:child_process')
      const child = spawn(exe, [], { detached: true, stdio: 'ignore', cwd: dirname(exe) })
      child.unref()
    } catch (err) {
      return `failed to start LunaTranslator: ${String(err).slice(0, 120)}`
    }
    for (let i = 0; i < 30; i++) {
      if (await up()) return `started LunaTranslator (took ${i + 1}s)`
      await new Promise((r) => setTimeout(r, 1000))
    }
    return 'started LunaTranslator but its port did not open within 30s'
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'gal_now',
        description: 'Current line of the visual novel the user is playing (speaker + text).',
        tags: ['read'],
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => {
          const r = await this.get('/current').catch(() => null)
          const l: Line | undefined = r?.line
          if (!l || !l.seq) return `No line yet (game may be in a menu). Luna: ${await this.ensureLuna()}`
          this.lastSeq = l.seq
          return fmt(l)
        },
      },
      {
        name: 'gal_wait',
        description: 'Wait for the next line (one line per click). Blocks up to 60s; timeout means the user paused.',
        tags: ['read'],
        parameters: { type: 'object', additionalProperties: false, properties: { timeout: { type: 'number' } } },
        handler: async (args) => {
          const timeout = Math.max(3, Math.min(110, Number(args.timeout ?? 45) || 45))
          const r = await this.get('/wait', { since: this.lastSeq, timeout })
          const lines: Line[] = r.lines ?? []
          if (!lines.length) return 'No new line within the timeout (user may be paused or reading a choice).'
          this.lastSeq = lines[lines.length - 1].seq
          return lines.map(fmt).join('\n')
        },
      },
      {
        name: 'gal_history',
        description: 'Recent lines (default 8, max 30).',
        tags: ['read'],
        parameters: { type: 'object', additionalProperties: false, properties: { count: { type: 'number' } } },
        handler: async (args) => {
          const count = Math.max(1, Math.min(30, Number(args.count ?? 8) || 8))
          const r = await this.get('/history', { limit: count })
          const lines: Line[] = r.lines ?? []
          if (!lines.length) return 'No lines yet.'
          this.lastSeq = lines[lines.length - 1].seq
          return lines.map(fmt).join('\n')
        },
      },
      {
        name: 'gal_advance',
        description: 'Click "next" in the game window in the background (does not steal focus).',
        tags: ['write'],
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { clicks: { type: 'number' }, process: { type: 'string' } },
        },
        handler: async (args) => {
          const clicks = Math.max(1, Math.min(10, Number(args.clicks ?? 1) || 1))
          const proc = String(args.process ?? this.targetProcess() ?? '').trim()
          if (!proc) return 'No game selected yet — call gal_use first.'
          const out = await run('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script('advance.ps1')], 60_000,
            { GAL_PROC: proc, GAL_CLICKS: String(clicks), GAL_DELAY: '900' })
          if (out.includes('NOPROC')) return `No window found for process ${proc}.`
          if (!out.includes('DONE')) return `Click failed: ${out.slice(0, 200)}`
          return `Sent ${clicks} background click(s). Use gal_wait to read what came next.`
        },
      },
      {
        name: 'gal_peek',
        description: 'Look at the game window right now (full frame, no diff).',
        tags: ['read'],
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => {
          const shot = await this.look(false)
          if (!shot) return `Could not capture: ${this.lastError || 'window not found'}`
          await this.push(shot.bytes, shot.note, 'peek')
          return `Here it is: ${shot.note}.`
        },
      },
      {
        name: 'gal_games',
        description: 'List visible windows that look like games (process / title / size).',
        tags: ['read'],
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => {
          const out = await run('powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', this.script('list-games.ps1')], 30_000)
          const rows = out.split(/\r?\n/).filter((l) => l.includes('\t'))
          if (!rows.length) return 'No game-like window found.'
          return 'Window / title / size:\n' + rows.map((r) => '- ' + r.replace(/\t/g, '  ')).join('\n') +
            '\nPick one with gal_use(process="...").'
        },
      },
      {
        name: 'gal_use',
        description: 'Select the game to follow: text, picture and clicking all use it.',
        tags: ['write'],
        parameters: {
          type: 'object', additionalProperties: false,
          properties: { process: { type: 'string' } }, required: ['process'],
        },
        handler: async (args) => {
          const proc = String(args.process ?? '').trim()
          if (!proc) return 'Give me a process name (see gal_games).'
          try {
            mkdirSync(dirname(this.targetPath()), { recursive: true })
            writeFileSync(this.targetPath(), JSON.stringify({ process: proc, ts: new Date().toISOString() }, null, 2), 'utf8')
          } catch (err) {
            return `Could not save: ${String(err).slice(0, 120)}`
          }
          this.lastFrame = null
          return `Following ${proc} from now on.`
        },
      },
      {
        name: 'gal_luna',
        description: 'Check / auto-start LunaTranslator when the game runs but no text arrives.',
        tags: ['write'],
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => `${await this.ensureLuna()}. Then try gal_now.`,
      },
      {
        name: 'gal_status',
        description: 'Current settings and counters.',
        tags: ['read'],
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        handler: async () => {
          const idle = this.lastPushAt ? Math.round((Date.now() - this.lastPushAt) / 1000) : null
          return [
            `game: ${this.targetProcess() || '(none)'}`,
            `bridge: ${this.base()}`,
            `picture: every ${this.cfg.everySec}s, ${this.cfg.diffMode ? 'changed region only' : 'full frame'}`,
            `auto push: ${this.cfg.pushImage ? 'on' : 'off'}`,
            `pushed this hour: ${this.pushesThisHour} / ${this.cfg.maxPushesPerHour}`,
            `last push: ${idle === null ? 'never' : idle + 's ago'}`,
            `last note: ${this.lastNote || 'none'}`,
            this.lastError ? `last error: ${this.lastError}` : '',
          ].filter(Boolean).join('\n')
        },
      },
    ]
  }
}

export const definition: WorldDefinition<GalConfig> = {
  id: 'gal',
  label: 'Visual novel companion',
  defaults: () => ({ ...DEFAULT_CONFIG }),
  describe: {
    tools: [
      { name: 'gal_now', description: 'current line', tags: ['read'] },
      { name: 'gal_wait', description: 'wait for next line', tags: ['read'] },
      { name: 'gal_history', description: 'recent lines', tags: ['read'] },
      { name: 'gal_advance', description: 'background click', tags: ['write'] },
      { name: 'gal_peek', description: 'look at the window', tags: ['read'] },
      { name: 'gal_games', description: 'list game windows', tags: ['read'] },
      { name: 'gal_use', description: 'select game', tags: ['write'] },
      { name: 'gal_luna', description: 'ensure LunaTranslator', tags: ['write'] },
      { name: 'gal_status', description: 'status', tags: ['read'] },
    ],
    events: [{ type: 'gal.picture', description: 'picture pushed when the game screen changes' }],
  },
  create(ctx) {
    const cfg = { ...DEFAULT_CONFIG, ...((ctx.cfg as Partial<GalConfig>) ?? {}) }
    return new GalWorld({ cfg, dataDir: ctx.dataDir })
  },
}

export default definition
