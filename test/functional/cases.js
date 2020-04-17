const test = require('ava')
const fs = require('fs-extra')
const path = require('path')
const async = require('async')
const { Sema } = require('async-sema')
const tmp = require('tmp-promise')
tmp.setGracefulCleanup()
const { transformFileAsync } = require('@babel/core')
const { spawn } = require('child_process')

const BABEL_CONFIG = {
  presets: [
    ['@babel/preset-env', {
      targets: {
        node: '12.16'
      }
    }]
  ],
  plugins: [
    ['@babel/plugin-transform-react-jsx', {
      pragma: 'queueWriteInstruction',
      pragmaFrag: 'Fragment',
      throwIfNamespace: false
    }]
  ]
}
const PROJECT_HOME = path.resolve(__dirname, '../..')
const PROJECT_DEPS = path.resolve(PROJECT_HOME, 'node_modules')
const PROJECT_MAIN = path.resolve(PROJECT_HOME, 'build/src/client.js')
const EXECUTABLE_FILE = path.resolve(PROJECT_HOME, 'build/src/replicator-engine')
const CASES = path.resolve(__dirname, 'cases')

const IN_FILE = 'in.xml'
const EXPECTED_FILE = 'out.xml'
const ACTUAL_FILE = 'actual.xml'
const TRANSFORMS_FILE = 'transforms.js'
const FIXTURES_FILE = 'fixtures.js'

const children = []
process.on('exit', () => {
  children.forEach(child => {
    if (child.exitCode == null) {
      child.kill('SIGINT')
    }
  })
})

const shimRequires = code => {
  return code
    .replace(/require\(['](?!replicator)(.*?)[']\)/g, (_, p1) => `require('${PROJECT_DEPS}/${p1}')`)
    .replace(/require\(["](?!replicator)(.*?)["]\)/g, (_, p1) => `require('${PROJECT_DEPS}/${p1}')`)
    .replace(/require\([']replicator[']\)/g, `require('${PROJECT_MAIN}')`)
    .replace(/require\(["]replicator["]\)/g, `require('${PROJECT_MAIN}')`)
}

const runCase = async (t, name) => {
  const caseDir = path.resolve(CASES, name)
  const tmpDir = await tmp.dir({ unsafeCleanup: true })
  let hasFixtures = false
  let jsOutput = []
  await async.forEach(
    (await fs.readdir(caseDir)),
    async file => {
      const file_path = path.resolve(caseDir, file)
      if (file.includes('fixtures')) {
        hasFixtures = true
      }
      if (file.endsWith('.jsx')) {
        const { code } = await transformFileAsync(file_path, BABEL_CONFIG)
        const shimmedCode = shimRequires(code)
        const newFilename = path.basename(file, '.jsx') + '.js'
        jsOutput.push([newFilename, shimmedCode])
        await fs.writeFile(path.resolve(tmpDir.path, newFilename), shimmedCode)
      } else if (file.endsWith('.js')) {
        const code = await fs.readFile(file_path, 'utf8')
        const shimmedCode = shimRequires(code)
        jsOutput.push([file, shimmedCode])
        await fs.writeFile(path.resolve(tmpDir.path, path.basename(file)), shimmedCode)
      } else {
        const data = await fs.readFile(file_path)
        await fs.writeFile(path.resolve(tmpDir.path, path.basename(file)), data)
      }
    }
  )
  const tmpManifest = path.resolve(tmpDir.path, 'manifest.yml')
  const manifestData = JSON.stringify({
    transforms: TRANSFORMS_FILE,
    ...(hasFixtures ? { fixtures: FIXTURES_FILE } : {})
  })
  await fs.writeFile(tmpManifest, manifestData)

  await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const replicator = spawn(EXECUTABLE_FILE, [
      '--node-coverage',
      '--node-workers=1',
      '--pretty-print',
      path.resolve(caseDir, IN_FILE),
      tmpManifest
    ]).on('exit', async code => {
      if (code !== 0) {
        console.error(stderr)
      }
      t.is(code, 0)
      const expected = (await fs.readFile(path.resolve(tmpDir.path, EXPECTED_FILE))).toString()
      if (stdout !== expected) {
        console.error('----- engine output -----')
        console.error(stderr)
        console.error('-------------------------')
        console.error('------- js output -------')
        for (const [filename, output] of jsOutput) {
          console.error(`// ${filename}`)
          console.error(output)
        }
        console.error('-------------------------')
        await fs.writeFile(path.resolve(caseDir, ACTUAL_FILE), stdout)
      }
      t.is(stdout, expected)
      resolve(undefined)
    })
    children.push(replicator)
    replicator.stdout.on('data', data => stdout += data.toString())
    replicator.stderr.on('data', data => stderr += data.toString())
  })
}

runCase.title = (providedTitle = '', name) => `${providedTitle} case-${name}`.trim();

const caseNames = fs.readdirSync(CASES)
const lock = new Sema(3, { capacity: caseNames.length })
test.beforeEach(async t => {
  await lock.acquire()
})
test.afterEach.always(t => {
  lock.release()
})

caseNames.forEach(caseDir => {
  test(runCase, caseDir)
})
