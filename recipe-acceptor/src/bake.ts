import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { UnixSocketBroker } from './node'
import workerFarm from 'worker-farm'
import lodash from 'lodash'

const runCommand = async(socketPath: string, manifestPath: string): Promise<void> => {
  const socketPathAbsolute = path.resolve(socketPath)
  const manifestPathAbsolute = path.resolve(manifestPath)

  const broker = new UnixSocketBroker(socketPathAbsolute)
  const numWorkers = 2
  const workers = workerFarm(path.resolve(__dirname, './transform-executor'), ['run'])
  process.on('exit', (_: number) => {
    workerFarm.end(workers)
  })

  try {
    const manifestDir = path.dirname(manifestPathAbsolute)
    const manifestString = fs.readFileSync(manifestPathAbsolute, { encoding: 'utf8' })
    const manifest = yaml.safeLoad(manifestString)

    const fixturesPath = manifest.fixtures == null
      ? undefined
      : path.resolve(manifestDir, manifest.fixtures)
    const transformsPath = manifest.transforms == null
      ? undefined
      : path.resolve(manifestDir, manifest.transforms)

    const spawnWorkers = async(transformsModulePath?: string, fixturesModulePath?: string): Promise<void> => {
      return new Promise((resolve, reject) => {
        let completed = 0
        for (const workerID of lodash.range(numWorkers)) {
          workers.run({
            socketPath: socketPathAbsolute,
            transformsPath: transformsModulePath,
            fixturesPath: fixturesModulePath,
            numWorkers,
            workerID
          }, (err: Error | null, _: undefined) => {
            if (err == null) {
              if (++completed === numWorkers) {
                resolve(undefined)
              }
            } else {
              reject(err)
            }
          })
        }
      })
    }

    await spawnWorkers(transformsPath, fixturesPath)

    await broker.reportComplete()
  } catch (err) {
    console.error(err)
    broker.reportError(err).catch(err => {
      console.error('Uh oh! Error occurred while reporting error!')
      throw err
    })
  } finally {
    workerFarm.end(workers)
  }
}

const socketPath = process.argv[2]
const manifestPath = process.argv[3]
runCommand(socketPath, manifestPath).catch(err => console.log(err))
