import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import async from 'async'
import { WriteInstruction } from './write-instruction'
import { Node, Broker, UnixSocketBroker } from './node'

type ReplacementFunction = (node: Node, fixtures?: any) => Promise<Array<WriteInstruction>>

export class TransformResult {
  nodeID: number
  mode: string
  instructions: Array<WriteInstruction>

  constructor(nodeID: number, mode: string, instructions: Array<WriteInstruction>) {
    this.nodeID = nodeID
    this.mode = mode
    this.instructions = instructions
  }
}

export class Transform {
  selector: string
  mode: string
  replace: ReplacementFunction

  constructor(selector: string, mode: string, replace: ReplacementFunction) {
    this.selector = selector
    this.mode = mode
    this.replace = replace
  }

  async resolve(root: Node): Promise<Array<TransformResult>> {
    const replaced = await root.select(this.selector)
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    return async.map(replaced, async node => {
      return new TransformResult(node.nodeID, this.mode, await this.replace(node))
    })
  }
}

export const resolveTransforms = async(transforms: Array<Transform>, broker: Broker): Promise<void> => {
  try {
    const root = await broker.getRoot()
    await broker.reportCount(transforms.length)
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    await async.each(transforms, async transform => {
      await broker.reportResults(await transform.resolve(root))
    })
    await broker.reportComplete()
  } catch (err) {
    await broker.reportError(err)
  }
}

export const runCommand = (socketPath: string, manifestPath: string): void => {
  const socketPathAbsolute = path.resolve(socketPath)
  const manifestPathAbsolute = path.resolve(manifestPath)

  const broker = new UnixSocketBroker(socketPathAbsolute)

  try {
    const manifestDir = path.dirname(manifestPathAbsolute)
    const manifestString = fs.readFileSync(manifestPathAbsolute, { encoding: 'utf8' })
    const manifest = yaml.safeLoad(manifestString)

    const collectTransforms = async(): Promise<Array<Transform>> => {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      return async.concat(manifest.modules, async(modulePathRelative: string) => {
        const modulePath = path.resolve(manifestDir, modulePathRelative)
        const moduleExports = await import(modulePath)
        return moduleExports.transforms
      }) as unknown as Promise<Array<Transform>>
    }

    const run = async(): Promise<void> => {
      const transforms = await collectTransforms()
      await resolveTransforms(transforms, broker)
    }

    run().catch(err => {
      broker.reportError(err).catch(err => {
        console.error('Uh oh! Error occurred while reporting error!')
        throw err
      })
    })
  } catch (err) {
    broker.reportError(err).catch(err => {
      console.error('Uh oh! Error occurred while reporting error!')
      throw err
    })
  }
}
