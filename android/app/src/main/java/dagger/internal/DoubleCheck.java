package dagger.internal;

/** Compatibility stub — Bridgefy SDK was compiled against this old Dagger API. */
public final class DoubleCheck<T> implements Provider<T> {

    private static final Object UNINITIALIZED = new Object();

    private Provider<T> provider;
    private volatile Object instance = UNINITIALIZED;

    private DoubleCheck(Provider<T> provider) {
        this.provider = provider;
    }

    @Override
    @SuppressWarnings("unchecked")
    public T get() {
        Object result = instance;
        if (result == UNINITIALIZED) {
            synchronized (this) {
                result = instance;
                if (result == UNINITIALIZED) {
                    result = provider.get();
                    instance = result;
                    provider = null;
                }
            }
        }
        return (T) result;
    }

    /** Old-API entry point used by Bridgefy-generated Dagger code. */
    public static <T> Provider<T> provider(Provider<T> delegate) {
        if (delegate instanceof DoubleCheck) {
            return delegate;
        }
        return new DoubleCheck<>(delegate);
    }
}
