import { Socket } from 'net'
import path from 'path'
import { TransformResult } from './bake'

export class QualifiedName {
  localName: string
  uri: string

  constructor(localName: string, uri: string) {
    this.localName = localName
    this.uri = uri
  }

  static fromExpandedName(name: string): QualifiedName {
    // {uri}localname
    const endOfUri = name.indexOf('}')
    return new QualifiedName(name.slice(endOfUri + 1), endOfUri === -1 ? '' : name.slice(1, endOfUri))
  }

  toNameString(): string {
    return `{${this.uri}}${this.localName}`
  }

  toRequest(): string {
    return JSON.stringify(
      { uri: this.uri, local_name: this.localName }
    )
  }

  equals(other: QualifiedName): boolean {
    return this.localName === other.localName && this.uri === other.uri
  }
}

export class Attribute {
  qName: QualifiedName
  value: string

  constructor(qName: QualifiedName, value: string) {
    this.qName = qName
    this.value = value
  }

  toRequest(): string {
    return JSON.stringify(
      { qualified_name: this.qName.toRequest(), value: this.value }
    )
  }
}

const selectionRequest = (nodeID: number, selector: string): string => {
  return JSON.stringify({
    Selection: { node_id: nodeID, selector: selector }
  })
}
const textRequest = (nodeID: number): string => {
  return JSON.stringify({
    Text: { node_id: nodeID }
  })
}
const attributeRequest = (nodeID: number): string => {
  return JSON.stringify({
    Attributes: { node_id: nodeID }
  })
}
const reportResultRequest = (results: Array<TransformResult>): string => {
  return JSON.stringify({
    PutResults: {
      results: results.map(transformResult => {
        return {
          node_id: transformResult.nodeID,
          mode: transformResult.mode,
          instructions: transformResult.instructions.map(instruction => instruction.toRequest())
        }
      })
    }
  })
}
const reportCountRequest = (count: number): string => {
  return JSON.stringify({
    PutCount: { count }
  })
}
const reportComplete = (): string => {
  return JSON.stringify({
    PutComplete: null
  })
}
const reportErrorRequest = (error: Error): string => {
  return JSON.stringify({
    PutError: { message: error.toString() }
  })
}

export class UnixSocketBroker implements Broker {
  socketFile: string

  constructor(socketFile: string) {
    this.socketFile = path.resolve(socketFile)
  }

  async select(nodeID: number, selector: string): Promise<Array<Node>> {
    const response = await this.socketConnection(selectionRequest(nodeID, selector))
    return response.Selection.elements.map((element: any) => {
      const qName = element.qualified_name
      return new Node(element.node_id, new QualifiedName(qName.local_name, qName.uri), this)
    })
  }

  async getText(nodeID: number): Promise<string> {
    const response = await this.socketConnection(textRequest(nodeID))
    return response.Text.text
  }

  async getAttributes(nodeID: number): Promise<Array<Attribute>> {
    const response = await this.socketConnection(attributeRequest(nodeID))
    return response.Attributes.attributes.map((attribute: any) => {
      const qName = attribute.qualified_name
      return new Attribute(new QualifiedName(qName.local_name, qName.uri), attribute.value)
    })
  }

  async getRoot(): Promise<Node> {
    return Promise.resolve(new Node(0, new QualifiedName('ROOT', ''), this))
  }

  async reportResults(results: Array<TransformResult>): Promise<void> {
    return this.socketConnectionOneWay(reportResultRequest(results))
  }

  async reportCount(count: number): Promise<void> {
    return this.socketConnectionOneWay(reportCountRequest(count))
  }

  async reportComplete(): Promise<void> {
    return this.socketConnectionOneWay(reportComplete())
  }

  async reportError(error: Error): Promise<void> {
    return this.socketConnectionOneWay(reportErrorRequest(error))
  }

  async socketConnectionOneWay(payload: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const connection: Socket = new Socket()
        .connect(this.socketFile, () => {
          connection.end(payload)
          resolve(undefined)
        })
    })
  }

  async socketConnection(payload: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const connection = new Socket().connect(this.socketFile, () => {
        connection.end(payload)
      }).on('data', data => {
        resolve(JSON.parse(data.toString()))
      })
    })
  }
}

export interface Broker {
  select(nodeID: number, selector: string): Promise<Array<Node>>
  getText(nodeID: number): Promise<string>
  getAttributes(nodeID: number): Promise<Array<Attribute>>
  getRoot(): Promise<Node>
  reportResults(result: Array<TransformResult>): Promise<void>
  reportCount(count: number): Promise<void>
  reportComplete(): Promise<void>
  reportError(error: Error): Promise<void>
}

export class Node {
  nodeID: number
  qName: QualifiedName
  broker: Broker

  constructor(nodeID: number, qName: QualifiedName, broker: Broker) {
    this.nodeID = nodeID
    this.qName = qName
    this.broker = broker
  }

  async select(selector: string): Promise<Array<Node>> {
    return this.broker.select(this.nodeID, selector)
  }

  async text(): Promise<string> {
    return this.broker.getText(this.nodeID)
  }

  async value(name: QualifiedName | string): Promise<string | undefined> {
    const attributes = await this.broker.getAttributes(this.nodeID)
    const matchAgainst = typeof name === 'string'
      ? new QualifiedName(name, '')
      : name
    const found = attributes.find(attr => attr.qName.equals(matchAgainst))
    return found == null ? found : found.value
  }

  async attributes(): Promise<Array<Attribute>> {
    return this.broker.getAttributes(this.nodeID)
  }

  name(): QualifiedName {
    return this.qName
  }
}
