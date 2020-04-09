const { Transform, Fragment, Replace, queueWriteInstruction, Copy } = require('replicator')

module.exports.transforms = [
  new Transform('//c', 'default', async node => {
    return (
      <Copy item={node}>
        {(await node.children()).map(child => {
          return child.name().localName == '#text'
            ? <>{'Fancy '}<Copy item={child} /></>
            : <Replace item={child} mode='default' />
        })}
      </Copy>
    )
  })
]