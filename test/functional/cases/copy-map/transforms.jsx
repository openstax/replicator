const { Transform, Fragment, ReplaceChildren, queueWriteInstruction, Copy } = require('replicator-xml')

module.exports.transforms = [
  new Transform('//h2', 'default', async node => {
    return (
      <Copy item={node} nameMap={() => 'h3'} attrMap={{ 'class': () => 'list-header' }}>
        <ReplaceChildren item={node} mode='default' />
      </Copy>
    )
  }),
  new Transform('//root', 'default', async node => {
    return (
      <Copy item={node} attrMap={{ 'class': () => null, 'switch': val => `${parseInt(val) ^ 1}` }}>
        <h2 class='document-title'>My Lists</h2>
        <ReplaceChildren item={node} mode='default' />
      </Copy>
    )
  })
]