# replicator
> "Tea, Earl Grey, Hot"

## Upcoming work
- [ ] Intersection selection types to provide tools to handle race conditions
- [ ] Refactor write processor to use xml-rs event builders
- [ ] Clean up error handling in main on OvenError with From impls
- [ ] Make SerializationError a real error and use fewer unwraps in serialization
- [ ] Add text-node/element-node selection in scandent with `:text`/`:element`
- [ ] Make number of JS workers configurable (default: 2), as this is overkill for things like small tests
- [ ] Tests for elements in namespaces