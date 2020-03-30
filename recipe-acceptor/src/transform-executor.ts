import { UnixSocketBroker } from './node'
import { resolveTransforms } from './execution'

async function helper(socketPath: string, modulePath: string, which: [number, number]): Promise<void> {
  const broker = new UnixSocketBroker(socketPath)
  const moduleExports = await import(modulePath)
  const transformsToRun = moduleExports.transforms.filter((_: any, index: number) => {
    return index % which[0] === which[1]
  })
  await resolveTransforms(transformsToRun, broker)
}

export function run(socketPath: string, modulePath: string, which: [number, number], callback: any): void {
  helper(socketPath, modulePath, which)
    .then(_ => {
      callback(null, undefined)
    })
    .catch(err => callback(err, undefined))
}
