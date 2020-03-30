import { UnixSocketBroker } from './node'
import { resolveTransforms } from './execution'

async function helper(args: RunArgs): Promise<void> {
  const broker = new UnixSocketBroker(args.socketPath)
  const transformsToRun = (args.transformsPath == null)
    ? []
    : (await import(args.transformsPath))
      ?.transforms
      ?.filter((_: any, index: number) => {
        return index % args.numWorkers === args.workerID
      }) as Array<any> | undefined ?? []
  const fixtures = (args.fixturesPath == null)
    ? {}
    : (await import(args.fixturesPath))
      ?.fixtures(broker) as object | undefined ?? {}
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
