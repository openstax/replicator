import test from 'ava'

import { queueWriteInstruction } from './../src/elements'
import { Transform, TransformResult, resolveTransforms } from './../src/bake'
import { Broker, Node, Attribute, QualifiedName } from './../src/node'

const sleep = async(ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class MockBroker implements Broker {
  memo: any
  completed: boolean
  count: number
  error?: Error
  reportedResults: Array<TransformResult>

  constructor(memo: any) {
    this.memo = memo
    this.completed = false
    this.count = 0
    this.error = undefined
    this.reportedResults = []
  }

  async select(nodeID: number, selector: string): Promise<Array<Node>> {
    return Promise.resolve(this.memo.select[nodeID][selector].call(this))
  }

  async getText(nodeID: number): Promise<string> {
    return Promise.resolve(this.memo.getText[nodeID].call(this))
  }

  async getAttributes(nodeID: number): Promise<Array<Attribute>> {
    return Promise.resolve(this.memo.getAttributes[nodeID].call(this))
  }

  async getRoot(): Promise<Node> {
    return Promise.resolve(this.memo.getRoot.call(this))
  }

  async reportResults(results: Array<TransformResult>): Promise<void> {
    this.reportedResults.push(...results)
    return Promise.resolve(undefined)
  }

  async reportCount(count: number): Promise<void> {
    this.count = count
    return Promise.resolve(undefined)
  }

  async reportComplete(): Promise<void> {
    this.completed = true
    return Promise.resolve(undefined)
  }

  async reportError(error: Error): Promise<void> {
    this.error = error
    return Promise.resolve(undefined)
  }
}

test('node_filters_attributes_for_value', async t => {
  const mockMemo = {
    getAttributes: {
      1: async() => Promise.resolve([
        new Attribute(new QualifiedName('attribute', ''), 'value'),
        new Attribute(new QualifiedName('attribute', 'openstax.org'), 'other-value')
      ])
    }
  }
  const mockBroker = new MockBroker(mockMemo)
  const node = new Node(1, new QualifiedName('', ''), mockBroker)

  t.is(await node.value('attribute'), 'value')
  t.is(await node.value(new QualifiedName('attribute', 'openstax.org')), 'other-value')
  t.falsy(await node.value(new QualifiedName('attribute', 'other-namespace.org')))
  t.falsy(await node.value(new QualifiedName('other-attribute', '')))
})

test('qualified_name_from_expanded_name_with_uri', t => {
  const name = '{openstax.org}document'
  const qName = QualifiedName.fromExpandedName(name)

  t.is(qName.localName, 'document')
  t.is(qName.uri, 'openstax.org')
})

test('qualified_name_from_expanded_name_no_uri', t => {
  const name = 'document'
  const qName = QualifiedName.fromExpandedName(name)

  t.is(qName.localName, 'document')
  t.is(qName.uri, '')
})

test('transforms_run_in_parallel', async t => {
  const mockMemo = {
    getRoot: function() { return new Node(0, new QualifiedName('ROOT', ''), this as unknown as Broker) },
    select: {
      0: {
        '//div-one': function() {
          return [new Node(1, new QualifiedName('div-one', ''), this as unknown as Broker)]
        },
        '//div-two': function() {
          return [new Node(2, new QualifiedName('div-two', ''), this as unknown as Broker)]
        },
        '//div-three': function() {
          return [new Node(3, new QualifiedName('div-three', ''), this as unknown as Broker)]
        }
      }
    }
  }
  const mockBroker = new MockBroker(mockMemo)
  const tranformFirst = new Transform('//div-one', 'default', async() => {
    await sleep(1500)
    return queueWriteInstruction('div-one-transformed')
  })
  const tranformSecond = new Transform('//div-two', 'default', async() => {
    await sleep(500)
    return queueWriteInstruction('div-two-transformed')
  })
  const tranformThird = new Transform('//div-three', 'default', async() => {
    await sleep(1000)
    return queueWriteInstruction('div-three-transformed')
  })
  await resolveTransforms([tranformFirst, tranformSecond, tranformThird], mockBroker)

  t.true(mockBroker.completed)
  t.falsy(mockBroker.error, undefined)
  t.is(mockBroker.reportedResults[0].nodeID, 2)
  t.is(mockBroker.reportedResults[1].nodeID, 3)
  t.is(mockBroker.reportedResults[2].nodeID, 1)
})

test('error_repored_when_occurs', async t => {
  const mockMemo = {
    getRoot: function() { return new Node(0, new QualifiedName('ROOT', ''), this as unknown as Broker) },
    select: {
      0: {
        '//div-one': function() {
          return [new Node(1, new QualifiedName('div-one', ''), this as unknown as Broker)]
        }
      }
    }
  }
  const mockBroker = new MockBroker(mockMemo)
  const tranformFirst = new Transform('//div-one', 'default', () => {
    throw new Error('an error')
  })
  await resolveTransforms([tranformFirst], mockBroker)

  t.false(mockBroker.completed)
  t.truthy(mockBroker.error)
})
