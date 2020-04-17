import async from 'async'
import { WriteInstruction, StartElement, Attributes, Text, EndElement, Replace as ReplaceInstruction } from './write-instruction'
import { Node, QualifiedName, Attribute } from './node'

type ComponentResult = Array<WriteInstruction>
type JsxAttributes = any
type JsxChildren = Array<string | Promise<ComponentResult> | JsxChildren>
interface Props {
  attributes: JsxAttributes
  children: JsxChildren
}
type ComponentFunction = (_: Props) => Promise<ComponentResult>
type ReplacementFunction = (node: Node, fixtures?: any) => Promise<ComponentResult | undefined>

export class Transform {
  selector: string
  mode: string
  replace: ReplacementFunction

  constructor(selector: string, mode: string, replace: ReplacementFunction) {
    this.selector = selector
    this.mode = mode
    this.replace = replace
  }

  async resolve(root: Node, fixtures: any): Promise<Array<TransformResult>> {
    const replaced = await root.select(this.selector)
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    return async.map(replaced, async node => {
      return new TransformResult(node.nodeID, this.mode, await this.replace(node, fixtures))
    })
  }
}

export class TransformResult {
  nodeID: number
  mode: string
  instructions: Array<WriteInstruction>

  constructor(nodeID: number, mode: string, instructions?: Array<WriteInstruction>) {
    this.nodeID = nodeID
    this.mode = mode
    this.instructions = instructions ?? []
  }
}

type AttrMapping = [string, (value?: string) => string]
export const Copy: ComponentFunction = async({ attributes, children }) => {
  const item: Node = attributes.item
  if (item == null) {
    throw new Error('Must provide item to Copy.')
  }
  let nodeName = item.name()
  if (nodeName.localName === '#text') {
    return [new Text(await item.text())]
  }
  if (attributes.nameMap != null) {
    nodeName = QualifiedName.fromExpandedName(attributes.nameMap(nodeName.localName, nodeName.uri))
  }

  let originalAttributes = await item.attributes()
  if (attributes.attrMap != null) {
    const attrMap = Object.entries(attributes.attrMap) as Array<AttrMapping>
    attrMap.forEach((attrMapping: AttrMapping) => {
      const [name, mapping] = attrMapping
      const match = originalAttributes.filter(attr => {
        return attr.qName.localName === name || attr.qName.toExpandedName() === name
      })
      if (match.length === 0) {
        originalAttributes.push(new Attribute(QualifiedName.fromExpandedName(name), mapping()))
        return
      }
      const matchMapped = match.reduce((acc, attr) => {
        const mapping = attributes.attrMap[attr.qName.toExpandedName()] ?? attributes.attrMap[attr.qName.localName]
        const newValue = mapping(attr.value)
        if (newValue == null) { return acc }
        attr.value = newValue
        acc.push(attr)
        return acc
      }, [] as Array<Attribute>)
      const notMatch = originalAttributes.filter(attr => {
        return !(attr.qName.localName === name || attr.qName.toExpandedName() === name)
      })
      originalAttributes = notMatch.concat(matchMapped)
    })
  }
  const nodeAttributes = originalAttributes
    .reduce((acc, attr) => {
      const name = attr.qName.toExpandedName()
      const value = attr.value
      return { ...acc, [name]: value }
    }, {})
  return queueWriteInstruction(nodeName.toExpandedName(), nodeAttributes, ...children)
}

const pushAwaitChildren = async(queue: ComponentResult, children: JsxChildren): Promise<ComponentResult> => {
  for (const child of children) {
    if (typeof child === 'string') {
      queue.push(new Text(child))
    } else if (child instanceof Promise) {
      queue.push(...(await child))
    } else if (Array.isArray(child)) {
      await pushAwaitChildren(queue, child)
    } else {
      throw new TypeError(`Expected string or Promise. Got ${typeof child}: ${JSON.stringify(child)}`)
    }
  }
  return queue
}

export const Replace: ComponentFunction = async({ attributes }) => {
  const item: Node = attributes.item
  const mode: string = attributes.mode
  if (item == null || mode == null) {
    throw new Error('Must provide both item and mode to Replace.')
  }
  return Promise.resolve([new ReplaceInstruction(item, mode)])
}

export const ReplaceChildren: ComponentFunction = async({ attributes }) => {
  const item: Node = attributes.item
  const mode: string = attributes.mode
  if (item == null || mode == null) {
    throw new Error('Must provide both item and mode to ReplaceChildren.')
  }
  const itemChildren = await item.children()
  return Promise.resolve(itemChildren.map(child => {
    if (child == null) {
      throw new Error('Child of ReplaceChildren item is null.')
    }
    return new ReplaceInstruction(child, mode)
  }
  ))
}

export const Fragment: ComponentFunction = async({ children }) => {
  return pushAwaitChildren([], children)
}

export const queueWriteInstruction = async(name: string | ComponentFunction, attributes?: JsxAttributes, ...children: JsxChildren): Promise<ComponentResult> => {
  if (typeof name === 'function') {
    return name({ attributes, children })
  }
  if (typeof name === 'string') {
    const queue = []
    const elementName = QualifiedName.fromExpandedName(name)
    queue.push(new StartElement(elementName))
    if (attributes != null) {
      const attributeInstructions = Object
        .entries(attributes)
        .map(([key, value]) => new Attribute(QualifiedName.fromExpandedName(key), value as string))
      if (attributeInstructions.length > 0) {
        queue.push(new Attributes(attributeInstructions))
      }
    }
    await pushAwaitChildren(queue, children)
    queue.push(new EndElement(elementName))
    return queue
  }
  throw new TypeError(`Expected string or function. Got ${typeof name}: ${JSON.stringify(name)}`)
}
