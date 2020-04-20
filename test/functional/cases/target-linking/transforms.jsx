const { Transform, Fragment, queueWriteInstruction, Copy } = require('replicator-xml')

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
