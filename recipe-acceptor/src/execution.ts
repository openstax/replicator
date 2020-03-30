import async from 'async'
import { Node, Broker } from './node'
import { WriteInstruction } from './write-instruction'

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
  } catch (err) {
    console.log(err)
    await broker.reportError(err)
  }
}
