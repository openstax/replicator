const { Transform, Fragment, ReplaceChildren, queueWriteInstruction, Copy } = require('replicator')

module.exports.transforms = [
  new Transform('//b', 'default', async node => {
    const linked = await node.followLink()
    const data = await linked.value('data')
    return (
      <Copy item={node}>
        <data>{data}</data>
      </Copy>
    )
  })
]
