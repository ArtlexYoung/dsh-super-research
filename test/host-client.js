import { open } from 'node:fs/promises'
import { build } from 'esbuild'

/** Load installed host singletons, including its real Markdown renderer, without booting the app. */
export async function installedClient() {
  const archive = await open(process.env.DSH_APP_ASAR || '/Applications/DSH NEXT.app/Contents/Resources/app.asar')
  try {
    const prefix = Buffer.alloc(16)
    await archive.read(prefix, 0, 16, 0)
    const json = Buffer.alloc(prefix.readUInt32LE(12))
    await archive.read(json, 0, json.length, 16)
    const tree = JSON.parse(json.toString()), base = 8 + prefix.readUInt32LE(4)
    const read = async path => {
      const entry = path.split('/').reduce((node, key) => node.files[key], tree)
      const value = Buffer.alloc(entry.size)
      await archive.read(value, 0, value.length, base + Number(entry.offset))
      return value.toString()
    }
    const assetRoot = 'node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/'
    const assets = tree.files.node_modules.files['@deepseek-ai'].files['dsh-web-frontend'].files.dist.files.assets.files
    const entryName = Object.keys(assets).find(name => /^index-.*\.js$/.test(name))
    const entry = await read(assetRoot + entryName)
    const seedName = /function (\w+)\(\)\{return\{react:/.exec(entry)?.[1]
    const startup = /const \w+=globalThis\.dshDesktopBoot/.exec(entry)?.index
    if (!seedName || !startup) throw new Error('Installed web seed changed; update this integration fixture')
    // Expose the shipped static module table; omit desktop boot and all host/network effects.
    const source = entry.slice(0, startup) + `\nwindow.HostModules = ${seedName}();`
    const bundled = await build({ stdin: { contents: source, sourcefile: entryName, resolveDir: '/' }, bundle: true, write: false, format: 'iife',
      define: { 'import.meta.url': '"http://host-fixture/assets/index.js"' },
      plugins: [{ name: 'installed-assets', setup(builder) {
        builder.onResolve({ filter: /^\.\// }, args => args.path.includes('/langs/')
          ? { path: args.path, external: true } : { path: args.path.slice(2), namespace: 'installed' })
        builder.onLoad({ filter: /./, namespace: 'installed' }, async args => ({ contents: await read(assetRoot + args.path), loader: 'js' }))
      } }] })
    return { seed: bundled.outputFiles[0].text,
      renderer: await read('node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js') }
  } finally { await archive.close() }
}
