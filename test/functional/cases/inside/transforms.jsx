const { Transform, Fragment, ReplaceChildren, queueWriteInstruction, Copy } = require('replicator')

module.exports.transforms = [
  new Transform('//c', 'default', async node => {
    return (
      <Copy item={node}>
        <d>
          <ReplaceChildren item={node} mode='default' />
        </d>
      </Copy>
    )
  })
]