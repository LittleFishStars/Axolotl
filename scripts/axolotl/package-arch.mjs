import { spawnSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

import { app, root, run, version as appVersion } from './desktop-build-utils.mjs'

const BINARY_NAME = 'axolotl-launcher'
const ICON_NAME = 'red.ghs.axolotl'
const RESOURCE_DIR_NAME = 'Axolotl Launcher'

const ELF_MACHINES = { 0x3e: 'x86_64', 0xb7: 'aarch64' }
const ARCH_BY_DEB = { amd64: 'x86_64', arm64: 'aarch64' }

const { values } = parseArgs({
    options: {
        binary: { type: 'string' },
        profile: { type: 'string', default: 'release' },
        resources: { type: 'string' },
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

function copyTree(source, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.cpSync(source, destination, { recursive: true, dereference: true })
}

function readConfig() {
    return JSON.parse(fs.readFileSync(path.join(app, 'tauri.conf.json'), 'utf8'))
}

function archFromElf(file) {
    const fd = fs.openSync(file, 'r')
    try {
        const header = Buffer.alloc(20)
        fs.readSync(fd, header, 0, 20, 0)
        if (header.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${file} is not an ELF binary`)
        const machine = header[5] === 2 ? header.readUInt16BE(18) : header.readUInt16LE(18)
        const arch = ELF_MACHINES[machine]
        if (!arch) throw new Error(`Unsupported ELF machine 0x${machine.toString(16)}`)
        return arch
    } finally {
        fs.closeSync(fd)
    }
}

function findBinary() {
    const candidates = values.binary
        ? [path.resolve(values.binary)]
        : [
              path.join(root, 'target', values.profile, 'Axolotl Launcher'),
              path.join(
                  root,
                  'target',
                  'release',
                  'bundle',
                  'deb',
                  `${RESOURCE_DIR_NAME}_${appVersion()}_amd64`,
                  'data',
                  'usr',
                  'bin',
                  'Axolotl Launcher',
              ),
          ]
    for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
    throw new Error(
        `No built launcher binary found (looked for ${candidates.join(', ')}); run the desktop build first or pass --binary`,
    )
}

function findResources() {
    const candidates = values.resources
        ? [path.resolve(values.resources)]
        : [
              path.join(root, 'target', values.profile, 'resources', 'blockbench-skin'),
              path.join(app, 'resources', 'blockbench-skin'),
          ]
    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, 'dist', 'skin.bundle.js.gz'))) return candidate
    }
    throw new Error(
        `No prepared blockbench-skin resources found (looked for ${candidates.join(', ')}); pass --resources`,
    )
}

function findIcons() {
    const icons = {
        '128x128': path.join(app, 'icons', '128x128.png'),
        '256x256@2': path.join(app, 'icons', '128x128@2x.png'),
    }
    for (const file of Object.values(icons)) {
        if (!fs.existsSync(file)) throw new Error(`Missing icon ${file}`)
    }
    return icons
}

function desktopEntry(config) {
    const mimeTypes = config.bundle.fileAssociations.map((association) => association.mimeType)
    mimeTypes.push(`x-scheme-handler/axolotl`)
    return [
        '[Desktop Entry]',
        `Categories=${config.bundle.category ?? 'Utility'};`,
        `Exec=/usr/bin/${BINARY_NAME}`,
        `StartupWMClass="${config.productName}"`,
        `Icon=${ICON_NAME}`,
        `Name=${config.productName}`,
        'Terminal=false',
        'Type=Application',
        `MimeType=${mimeTypes.join(';')}`,
        '',
    ].join('\n')
}

function assemblePkgdir(pkgdir) {
    const config = readConfig()
    const binary = findBinary()
    const resources = findResources()
    const icons = findIcons()

    const binDir = path.join(pkgdir, 'usr/bin')
    fs.mkdirSync(binDir, { recursive: true })
    fs.copyFileSync(binary, path.join(binDir, BINARY_NAME))
    fs.chmodSync(path.join(binDir, BINARY_NAME), 0o755)

    copyTree(
        resources,
        path.join(pkgdir, 'usr/lib', RESOURCE_DIR_NAME, 'resources', 'blockbench-skin'),
    )

    for (const [size, source] of Object.entries(icons)) {
        const destination = path.join(
            pkgdir,
            'usr/share/icons/hicolor',
            size,
            'apps',
            `${ICON_NAME}.png`,
        )
        fs.mkdirSync(path.dirname(destination), { recursive: true })
        fs.copyFileSync(source, destination)
    }

    const desktop = path.join(pkgdir, 'usr/share/applications', `${BINARY_NAME}.desktop`)
    fs.mkdirSync(path.dirname(desktop), { recursive: true })
    fs.writeFileSync(desktop, desktopEntry(config))

    return archFromElf(binary)
}

function extractDeb(deb, pkgdir) {
    const tmp = fs.mkdtempSync(path.join(path.dirname(pkgdir), '.deb-'))
    try {
        run('bsdtar', ['-xf', deb, '-C', tmp])
        const controlDir = path.join(tmp, 'control')
        fs.mkdirSync(controlDir)
        const controlMember = fs
            .readdirSync(tmp)
            .find((entry) => entry.startsWith('control.tar.'))
        if (!controlMember) throw new Error('Deb archive is missing control.tar')
        run('bsdtar', ['-xf', path.join(tmp, controlMember), '-C', controlDir])
        const controlFile = fs.existsSync(path.join(controlDir, 'control'))
            ? path.join(controlDir, 'control')
            : path.join(controlDir, './control')
        const control = {}
        let current = null
        for (const line of fs.readFileSync(controlFile, 'utf8').split('\n')) {
            if (line.startsWith(' ') && current) control[current] += line
            else {
                const match = line.match(/^([A-Za-z-]+):\s*(.*)$/)
                if (match) {
                    current = match[1]
                    control[current] = match[2]
                }
            }
        }
        const arch = ARCH_BY_DEB[control.Architecture]
        if (!arch) throw new Error(`Unsupported deb architecture: ${control.Architecture}`)
        const dataMember = fs.readdirSync(tmp).find((entry) => entry.startsWith('data.tar.'))
        if (!dataMember) throw new Error('Deb archive is missing data.tar')
        fs.mkdirSync(pkgdir)
        run('bsdtar', ['-xf', path.join(tmp, dataMember), '-C', pkgdir])

        const binary = path.join(pkgdir, 'usr/bin', RESOURCE_DIR_NAME)
        if (fs.existsSync(binary)) fs.renameSync(binary, path.join(pkgdir, 'usr/bin', BINARY_NAME))
        const desktop = path.join(pkgdir, 'usr/share/applications', `${RESOURCE_DIR_NAME}.desktop`)
        if (fs.existsSync(desktop)) {
            fs.renameSync(desktop, path.join(pkgdir, 'usr/share/applications', `${BINARY_NAME}.desktop`))
        }
        for (const size of ['128x128', '256x256@2']) {
            const icon = path.join(pkgdir, 'usr/share/icons/hicolor', size, 'apps', `${RESOURCE_DIR_NAME}.png`)
            if (fs.existsSync(icon)) {
                fs.renameSync(icon, path.join(path.dirname(icon), `${ICON_NAME}.png`))
            }
        }
        fs.chmodSync(path.join(pkgdir, 'usr/bin', BINARY_NAME), 0o755)
        return arch
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
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
    const file = path.join(output, `${BINARY_NAME}-${pkgver}-${arch}.pkg.tar.zst`)
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

const output = path.resolve(values.output)
fs.mkdirSync(output, { recursive: true })
const tmp = fs.mkdtempSync(path.join(output, '.work-'))
try {
    const pkgdir = path.join(tmp, 'pkg')
    const arch = values.deb ? extractDeb(path.resolve(values.deb), pkgdir) : assemblePkgdir(pkgdir)
    const pkgver = writePkginfo(pkgdir, arch)
    writeMtree(pkgdir)
    const file = createPackage(pkgdir, output, pkgver, arch)
    console.log(`Created ${file}`)
    if (values.install) run('sudo', ['pacman', '-U', file])
    else console.log(`Install with: sudo pacman -U ${file}`)
} finally {
    fs.rmSync(tmp, { recursive: true, force: true })
}
