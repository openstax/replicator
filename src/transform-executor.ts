import async from 'async'
import { Transform } from './client'
import { Broker, UnixSocketBroker } from './node'

export const resolveTransforms = async(transforms: Array<Transform>, broker: Broker, fixtures: any): Promise<void> => {
  try {
    const root = await broker.getRoot()
    await broker.reportCount(transforms.length)
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    await async.each(transforms, async transform => {
      await broker.reportResults(await transform.resolve(root, fixtures))
    })
  } catch (err) {
    await broker.reportError(err).catch(err => {
      console.error('Uh oh! Error occurred while reporting error!')
      throw err
    })
  }
}

async function helper(args: RunArgs): Promise<void> {
  const broker = new UnixSocketBroker(args.socketPath)
  const root = await broker.getRoot()
  const transformsToRun = (args.transformsPath == null)
    ? []
    : (await import(args.transformsPath))
      ?.transforms
      ?.filter((_: any, index: number) => {
        return index % args.numWorkers === args.workerID
      }) as Array<any> | undefined ?? []
  const fixtures = (args.fixturesPath == null)
    ? {}
    : await (await import(args.fixturesPath))?.fixtures(root) as object | undefined ?? {}
  if (transformsToRun.length === 0) {
    console.error(`Warning (workerID ${args.workerID}): No transformations were passed to be run`)
  }
  await resolveTransforms(transformsToRun, broker, fixtures)
}

interface RunArgs {
  socketPath: string
  transformsPath?: string
  numWorkers: number
  workerID: number
  fixturesPath?: string
}

export function run(args: RunArgs, callback: any): void {
  helper(args)
    .then(_ => {
      callback(null, undefined)
    })
    .catch(err => callback(err, undefined))
}
