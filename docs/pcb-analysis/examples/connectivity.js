const a = analysis({ board });
await a.geometry().name('copper-connectivity').rules([{ kind: 'connectivity' }]).run();
