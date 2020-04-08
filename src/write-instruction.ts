import { QualifiedName, Attribute, Node } from './node'

export interface WriteInstruction {
  toRequestObj(): any
}

export class StartElement implements WriteInstruction {
  name: QualifiedName
  constructor(name: QualifiedName) {
    this.name = name
  }

  toRequestObj(): any {
    return { S: { q: this.name.toRequestObj() } }
  }
}

export class EndElement implements WriteInstruction {
  name: QualifiedName
  constructor(name: QualifiedName) {
    this.name = name
  }

  toRequestObj(): any {
    return { E: { q: this.name.toRequestObj() } }
  }
}

export class Text implements WriteInstruction {
  text: string
  constructor(text: string) {
    this.text = text
  }

  toRequestObj(): any {
    return { T: { t: this.text } }
  }
}

export class Attributes implements WriteInstruction {
  attributes: Array<Attribute>
  constructor(attributes: Array<Attribute>) {
    this.attributes = attributes
  }

  toRequestObj(): any {
    return { A: { a: this.attributes } }
  }
}

export class Replace implements WriteInstruction {
  node: Node
  mode: string
  constructor(node: Node, mode: string) {
    this.node = node
    this.mode = mode
  }

  toRequestObj(): any {
    return { R: { n: this.node.nodeID, m: this.mode } }
  }
}

// Unimplemented WriteInstructions
// class StartDocument implements WriteInstruction {}
// class EndDocument implements WriteInstruction {}
// class PI implements WriteInstruction {}
// class Comment implements WriteInstruction {}
// class Namespaces implements WriteInstruction {}
