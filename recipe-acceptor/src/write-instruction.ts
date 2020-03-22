import { QualifiedName, Attribute, Node } from './node'

export interface WriteInstruction {
  toRequest(): string
}

export class StartElement implements WriteInstruction {
  name: QualifiedName
  constructor(name: QualifiedName) {
    this.name = name
  }

  toRequest(): string {
    return JSON.stringify({
      StartElementInstruction: { qualified_name: this.name.toRequest() }
    })
  }
}

export class EndElement implements WriteInstruction {
  name: QualifiedName
  constructor(name: QualifiedName) {
    this.name = name
  }

  toRequest(): string {
    return JSON.stringify({
      EndElementInstruction: { qualified_name: this.name.toRequest() }
    })
  }
}

export class Text implements WriteInstruction {
  text: string
  constructor(text: string) {
    this.text = text
  }

  toRequest(): string {
    return JSON.stringify({
      TextInstruction: { text: this.text }
    })
  }
}

export class Attributes implements WriteInstruction {
  attributes: Array<Attribute>
  constructor(attributes: Array<Attribute>) {
    this.attributes = attributes
  }

  toRequest(): string {
    return JSON.stringify({
      AttributeInstruction: { attributes: this.attributes }
    })
  }
}

export class Replace implements WriteInstruction {
  node: Node
  mode: string
  constructor(node: Node, mode: string) {
    this.node = node
    this.mode = mode
  }

  toRequest(): string {
    return JSON.stringify({
      ReplaceInstruction: { node_id: this.node.nodeID, mode: this.mode }
    })
  }
}

// Unimplemented WriteInstructions
// class StartDocument implements WriteInstruction {}
// class EndDocument implements WriteInstruction {}
// class PI implements WriteInstruction {}
// class Comment implements WriteInstruction {}
