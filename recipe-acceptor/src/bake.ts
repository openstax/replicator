import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import async from 'async'
import { UnixSocketBroker } from './node'
import workerFarm from 'worker-farm'
import lodash from 'lodash'

export const runCommand = async(socketPath: string, manifestPath: string): Promise<void> => {
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

    const spawnWorkers: (modulePath: string) => Promise<void> = async modulePath => {
      return new Promise((resolve, reject) => {
        let completed = 0
        for (const workerID of lodash.range(numWorkers)) {
          workers.run(socketPathAbsolute, modulePath, [numWorkers, workerID], (err: Error | null, _: undefined) => {
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

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    await async.each(manifest.modules, async(modulePathRelative: string) => {
      const modulePath = path.resolve(manifestDir, modulePathRelative)
      await spawnWorkers(modulePath)
    })

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
