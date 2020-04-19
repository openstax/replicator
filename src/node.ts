import { Socket } from 'net'
import path from 'path'
import { TransformResult } from './client'

export class QualifiedName {
  localName: string
  uri: string

  constructor(localName: string, uri: string) {
    this.localName = localName
    this.uri = uri
  }

  static fromExpandedName(name: string): QualifiedName {
    // form: {uri}localname
    const endOfUri = name.indexOf('}')
    return new QualifiedName(name.slice(endOfUri + 1), endOfUri === -1 ? '' : name.slice(1, endOfUri))
  }

  toExpandedName(): string {
    return `{${this.uri}}${this.localName}`
  }

  toRequestObj(): any {
    return { u: this.uri, l: this.localName }
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

  toRequestObj(): any {
    return { q: this.qName.toRequestObj(), v: this.value }
  }
}

const selectionRequest = (nodeID: number, selector: string): string => {
  return JSON.stringify({
    S: { n: nodeID, s: selector }
  })
}
const textRequest = (nodeID: number): string => {
  return JSON.stringify({
    T: { n: nodeID }
  })
}
const attributeRequest = (nodeID: number): string => {
  return JSON.stringify({
    A: { n: nodeID }
  })
}
const reportResultRequest = (results: Array<TransformResult>): string => {
  return JSON.stringify({
    R: {
      r: results.map(transformResult => {
        return {
          n: transformResult.nodeID,
          m: transformResult.mode,
          i: transformResult.instructions.map(instruction => instruction.toRequestObj())
        }
      })
    }
  })
}
const reportCountRequest = (count: number): string => {
  return JSON.stringify({
    C: { c: count }
  })
}
const reportComplete = (): string => {
  return JSON.stringify({
    CC: null
  })
}
const reportErrorRequest = (error: Error): string => {
  return JSON.stringify({
    E: { m: error.stack ?? error.toString() }
  })
}

export class UnixSocketBroker implements Broker {
  socketFile: string
  count: number

  constructor(socketFile: string) {
    this.socketFile = path.resolve(socketFile)
    this.count = 0
  }

  async select(nodeID: number, selector: string): Promise<Array<Node>> {
    const response = await this.socketConnection(selectionRequest(nodeID, selector))
    return response.S.e.map((element: any) => {
      const qName = element.q
      return new Node(element.n, new QualifiedName(qName.l, qName.u), this)
    })
  }

  async getText(nodeID: number): Promise<string> {
    const response = await this.socketConnection(textRequest(nodeID))
    return response.T.t
  }

  async getAttributes(nodeID: number): Promise<Array<Attribute>> {
    const response = await this.socketConnection(attributeRequest(nodeID))
    return response.A.a.map((attribute: any) => {
      const qName = attribute.q
      return new Attribute(new QualifiedName(qName.l, qName.u), attribute.v)
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
        .on('connect', () => {
          connection.end(payload)
        })
        .on('end', () => {
          resolve(undefined)
        })
        .on('error', (err: any) => {
          if (err.code === 'EAGAIN') {
            connection.connect(this.socketFile)
            return
          }
          connection.destroy()
          reject(err)
        })
        .connect(this.socketFile)
    })
  }

  async socketConnection(payload: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const buffers: Array<Buffer> = []
      const connection = new Socket()
        .on('connect', () => {
          connection.end(payload)
        })
        .on('data', data => {
          buffers.push(data)
        })
        .on('end', () => {
          const responseString = Buffer.concat(buffers).toString()
          const responseObj = JSON.parse(responseString)
          if (responseObj?.B?.r != null) {
            reject(new Error(responseObj.B.r))
          }
          resolve(responseObj)
        })
        .on('error', (err: any) => {
          if (err.code === 'EAGAIN') {
            connection.connect(this.socketFile)
            return
          }
          reject(err)
        })
        .connect(this.socketFile)
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

  async selectOne(selector: string): Promise<Node | undefined> {
    const selection = await this.broker.select(this.nodeID, selector)
    if (selection.length === 0) {
      return undefined
    }
    return selection[0]
  }

  async text(): Promise<string> {
    return this.broker.getText(this.nodeID)
  }

  async value(name: QualifiedName | string): Promise<string | undefined> {
    const attributes = await this.broker.getAttributes(this.nodeID)
    const matchAgainst = typeof name === 'string'
      ? QualifiedName.fromExpandedName(name)
      : name
    const found = attributes.find(attr => attr.qName.equals(matchAgainst))
    return found == null ? found : found.value
  }

  async attributes(): Promise<Array<Attribute>> {
    return this.broker.getAttributes(this.nodeID)
  }

  async children(): Promise<Array<Node>> {
    return this.select('/*')
  }

  async followLink(): Promise<Node | undefined> {
    const hrefValue = await this.value('{}href')
    if (hrefValue == null) {
      return undefined
    }
    if (!hrefValue.startsWith('#')) {
      return undefined
    }
    const root = await this.broker.getRoot()
    return root.selectOne(`//[id==${JSON.stringify(hrefValue.slice(1))}]`)
  }

  isText(): boolean {
    return this.name().localName === '#text'
  }

  equals(other: Node): boolean {
    return this.nodeID === other.nodeID
  }

  id(): number {
    return this.nodeID
  }

  name(): QualifiedName {
    return this.qName
  }
}
