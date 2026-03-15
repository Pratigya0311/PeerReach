package dagger.internal;

/** Compatibility stub — Bridgefy SDK was compiled against this type. */
public final class InstanceFactory<T> implements Factory<T> {

    private final T instance;

    private InstanceFactory(T instance) {
        this.instance = Preconditions.checkNotNull(instance, "instance cannot be null");
    }

    @Override
    public T get() {
        return instance;
    }

    public static <T> Factory<T> create(T instance) {
        return new InstanceFactory<>(instance);
    }
}
