import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { root, run, version as appVersion } from './desktop-build-utils.mjs'

const PRODUCT_BINARY = 'Axolotl Launcher'
const BINARY_NAME = 'axolotl-launcher'
const ICON_NAME = 'red.ghs.axolotl'
const ARCH_BY_DEB = { amd64: 'x86_64', arm64: 'aarch64' }

const { values } = parseArgs({
    options: {
        deb: { type: 'string' },
        output: { type: 'string', default: path.join(root, 'target/arch') },
        pkginfo: { type: 'string', default: path.join(root, 'packaging/arch/PKGINFO') },
        pkgrel: { type: 'string', default: '1' },
        install: { type: 'boolean' },
    },
})

function spawnCapture(command, args) {
    const result = spawnSync(command, args, {
        encoding: 'buffer',
        maxBuffer: 1024 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit'],
    })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${command} ${args[0]} failed (${result.status})`)
    return result.stdout
}

function findDeb() {
    if (values.deb) return path.resolve(values.deb)
    const directory = path.join(root, 'target/release/bundle/deb')
    if (!fs.existsSync(directory)) {
        throw new Error(
            'No Tauri deb bundle found; run the desktop build first, e.g. `node scripts/axolotl/build-desktop.mjs --profile ci` then `pnpm --filter @modrinth/app tauri bundle --ci --config tauri-release.conf.json`',
        )
    }
    const candidates = fs
        .readdirSync(directory, { recursive: true })
        .filter((entry) => entry.endsWith('.deb'))
        .map((entry) => {
            const file = path.join(directory, entry)
            return { file, stats: fs.statSync(file) }
        })
        .filter((entry) => entry.stats.isFile())
        .sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)
    if (candidates.length === 0) throw new Error(`No .deb under ${directory}`)
    const preferred = candidates.find((entry) => path.basename(entry.file).includes(appVersion()))
    return (preferred ?? candidates[0]).file
}

function parseControl(tmp) {
    const member = fs.readdirSync(tmp).find((entry) => entry.startsWith('control.tar.'))
    if (!member) throw new Error('Deb archive is missing control.tar')
    const directory = path.join(tmp, 'control')
    fs.mkdirSync(directory)
    run('bsdtar', ['-xf', path.join(tmp, member), '-C', directory])
    const controlFile = fs.existsSync(path.join(directory, 'control'))
        ? path.join(directory, 'control')
        : path.join(directory, './control')
    const text = fs.readFileSync(controlFile, 'utf8')
    const control = {}
    let current = null
    for (const line of text.split('\n')) {
        if (line.startsWith(' ') && current) control[current] += line
        else {
            const match = line.match(/^([A-Za-z-]+):\s*(.*)$/)
            if (match) {
                current = match[1]
                control[current] = match[2]
            }
        }
    }
    return control
}

function walkFiles(directory) {
    return fs
        .readdirSync(directory, { withFileTypes: true, recursive: true })
        .filter((entry) => entry.isFile())
}

function installedSize(pkgdir) {
    return walkFiles(pkgdir).reduce((total, entry) => {
        return total + fs.statSync(path.join(entry.parentPath, entry.name)).size
    }, 0)
}

function normalizePayload(pkgdir) {
    const binary = path.join(pkgdir, 'usr/bin', PRODUCT_BINARY)
    if (fs.existsSync(binary)) {
        fs.renameSync(binary, path.join(pkgdir, 'usr/bin', BINARY_NAME))
        fs.chmodSync(path.join(pkgdir, 'usr/bin', BINARY_NAME), 0o755)
    }
    const desktop = path.join(pkgdir, 'usr/share/applications', `${PRODUCT_BINARY}.desktop`)
    if (fs.existsSync(desktop)) {
        const text = fs.readFileSync(desktop, 'utf8')
        const updated = text
            .split('\n')
            .map((line) => {
                if (line.startsWith('Exec=')) {
                    const codes = line.match(/%[a-zA-Z]/g)?.join(' ') ?? ''
                    return `Exec=/usr/bin/${BINARY_NAME}${codes ? ` ${codes}` : ''}`
                }
                if (line.startsWith('Icon=')) return `Icon=${ICON_NAME}`
                return line
            })
            .join('\n')
        fs.writeFileSync(desktop, updated)
        fs.renameSync(
            desktop,
            path.join(pkgdir, 'usr/share/applications', `${BINARY_NAME}.desktop`),
        )
    }
    const icons = path.join(pkgdir, 'usr/share/icons')
    if (fs.existsSync(icons)) {
        for (const entry of walkFiles(icons)) {
            if (entry.name === `${PRODUCT_BINARY}.png`) {
                fs.renameSync(
                    path.join(entry.parentPath, entry.name),
                    path.join(entry.parentPath, `${ICON_NAME}.png`),
                )
            }
        }
    }
}

function writePkginfo(pkgdir, arch) {
    const pkgver = `${appVersion().replaceAll('-', '.')}-${values.pkgrel}`
    const overrides = {
        pkgver,
        arch,
        builddate: String(Math.floor(Date.now() / 1000)),
        size: String(installedSize(pkgdir)),
    }
    const lines = fs
        .readFileSync(values.pkginfo, 'utf8')
        .split('\n')
        .map((line) => {
            const key = line.match(/^([a-z]+) =/)?.[1]
            return key in overrides ? `${key} = ${overrides[key]}` : line
        })
    fs.writeFileSync(path.join(pkgdir, '.PKGINFO'), `${lines.join('\n')}\n`)
    return pkgver
}

function writeMtree(pkgdir) {
    const mtree = spawnCapture('bsdtar', [
        '-cf',
        '-',
        '--format=mtree',
        '--options=!all,use-set,type,uid,gid,mode,time,size,md5digest,sha256digest',
        '--exclude=.PKGINFO',
        '-C',
        pkgdir,
        '.',
    ])
        .toString('utf8')
        .replace(/uid=\d+/g, 'uid=0')
        .replace(/gid=\d+/g, 'gid=0')
    fs.writeFileSync(path.join(pkgdir, '.MTREE'), gzipSync(Buffer.from(mtree), { level: 9 }))
}

function createPackage(pkgdir, output, pkgver, arch) {
    const file = path.join(output, `axolotl-launcher-${pkgver}-${arch}.pkg.tar.zst`)
    const entries = [
        '.PKGINFO',
        '.MTREE',
        ...fs.readdirSync(pkgdir).filter((entry) => !['.PKGINFO', '.MTREE'].includes(entry)),
    ]
    run('bsdtar', [
        '-acf',
        file,
        '--uid',
        '0',
        '--gid',
        '0',
        '--uname',
        'root',
        '--gname',
        'root',
        '-C',
        pkgdir,
        ...entries,
    ])
    return file
}

const deb = findDeb()
const output = path.resolve(values.output)
fs.mkdirSync(output, { recursive: true })
const tmp = fs.mkdtempSync(path.join(output, '.work-'))
try {
    run('bsdtar', ['-xf', deb, '-C', tmp])
    const control = parseControl(tmp)
    const arch = ARCH_BY_DEB[control.Architecture]
    if (!arch) throw new Error(`Unsupported deb architecture: ${control.Architecture}`)
    const data = fs.readdirSync(tmp).find((entry) => entry.startsWith('data.tar.'))
    if (!data) throw new Error('Deb archive is missing data.tar')
    const pkgdir = path.join(tmp, 'pkg')
    fs.mkdirSync(pkgdir)
    run('bsdtar', ['-xf', path.join(tmp, data), '-C', pkgdir])
    normalizePayload(pkgdir)
    const pkgver = writePkginfo(pkgdir, arch)
    writeMtree(pkgdir)
    const file = createPackage(pkgdir, output, pkgver, arch)
    console.log(`Created ${file}`)
    if (values.install) run('sudo', ['pacman', '-U', file])
    else console.log(`Install with: sudo pacman -U ${file}`)
} finally {
    fs.rmSync(tmp, { recursive: true, force: true })
}
