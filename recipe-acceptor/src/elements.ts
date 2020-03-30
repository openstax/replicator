import { WriteInstruction, StartElement, Attributes, Text, EndElement, Replace as ReplaceInstruction } from './write-instruction'
import { Node, QualifiedName, Attribute } from './node'

type ComponentResult = Array<WriteInstruction>
type JsxAttributes = any
type JsxChildren = Array<string | Promise<ComponentResult>>
interface Props {
  attributes?: JsxAttributes
  children?: JsxChildren
}
type ComponentFunction = (_: Props) => Promise<ComponentResult>

export const Copy: ComponentFunction = async({ attributes, children }) => {
  // TODO: allow attributes that can transform properties of the given element
  const item: Node = attributes.item
  const nodeName = item.name()
  const nodeAttributes = (await item.attributes())
    .reduce((acc, attr) => {
      const name = attr.qName.toExpandedName()
      const value = attr.value
      return { ...acc, [name]: value }
    }, {})
  const content = children != null ? children : []
  return queueWriteInstruction(nodeName.toExpandedName(), nodeAttributes, ...content)
}

export const Replace: ComponentFunction = async({ attributes, children }) => {
  const item: Node = attributes.item
  const mode: string = attributes.mode
  return Promise.resolve([new ReplaceInstruction(item, mode)])
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
      queue.push(new Attributes(
        Object
          .entries(attributes)
          .map(([key, value]) => new Attribute(QualifiedName.fromExpandedName(key), value as string))
      ))
    }
    for (const child of children) {
      if (typeof child === 'string') {
        queue.push(new Text(child))
      } else if (child instanceof Promise) {
        queue.push(...(await child))
      } else {
        throw new TypeError(`Expected string or Promise. Got ${typeof child}`)
      }
    }
    queue.push(new EndElement(elementName))
    return queue
  }
  throw new TypeError(`Expected string or function. Got ${typeof name}`)
}
