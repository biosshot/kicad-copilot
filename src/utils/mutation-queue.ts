import PQueue from 'p-queue';

const mutationQueue = new PQueue({ concurrency: 1 });

export function enqueueMutation<T>(operation: () => Promise<T>) {
    return mutationQueue.add(operation);
}
