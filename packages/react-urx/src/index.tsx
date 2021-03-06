import * as React from 'react'
import {
  ComponentType,
  createContext,
  forwardRef,
  ForwardRefExoticComponent,
  RefAttributes,
  useContext,
  useEffect,
  useImperativeHandle,
  useState,
} from 'react'
import {
  AnyEngine,
  reset,
  curry1to0,
  curry2to1,
  Emitter,
  EngineSystem,
  eventHandler,
  getValue,
  publish,
  Publisher,
  run,
  StatefulStream,
  Stream,
  subscribe,
} from 'urx'

interface Dict<T> {
  [key: string]: T
}

function omit<O extends Dict<any>, K extends readonly string[]>(keys: K, obj: O): Omit<O, K[number]> {
  var result = {} as Dict<any>
  var index = {} as Dict<1>
  var idx = 0
  var len = keys.length

  while (idx < len) {
    index[keys[idx]] = 1
    idx += 1
  }

  for (var prop in obj) {
    if (!index.hasOwnProperty(prop)) {
      result[prop] = obj[prop]
    }
  }

  return result as any
}

export type Observable<T> = Emitter<T> | Publisher<T>

export interface EnginePropsMap<E extends AnyEngine> {
  required?: {
    [propName: string]: keyof EngineSystem<E>
  }
  optional?: {
    [propName: string]: keyof EngineSystem<E>
  }
  methods?: {
    [propName: string]: keyof EngineSystem<E>
  }
  events?: {
    [propName: string]: keyof EngineSystem<E>
  }
  ssrProps?: (keyof EngineSystem<E>)[]
}

export type PropsFromPropMap<E extends AnyEngine, M extends EnginePropsMap<E>> = {
  [K in Extract<keyof M['required'], string>]: M['required'][K] extends string
    ? EngineSystem<E>[M['required'][K]] extends Observable<infer R>
      ? R
      : never
    : never
} &
  {
    [K in Extract<keyof M['optional'], string>]?: M['optional'][K] extends string
      ? EngineSystem<E>[M['optional'][K]] extends Observable<infer R>
        ? R
        : never
      : never
  } &
  {
    [K in Extract<keyof M['events'], string>]?: M['events'][K] extends string
      ? EngineSystem<E>[M['events'][K]] extends Observable<infer R>
        ? (value: R) => void
        : never
      : never
  }

export type MethodsFromPropMap<E extends AnyEngine, M extends EnginePropsMap<E>> = {
  [K in Extract<keyof M['methods'], string>]: M['methods'][K] extends string
    ? EngineSystem<E>[M['methods'][K]] extends Observable<infer R>
      ? (value: R) => void
      : never
    : never
}

export type RefHandle<T> = T extends ForwardRefExoticComponent<RefAttributes<infer T2>> ? T2 : never

export function engineToComponent<
  E extends AnyEngine,
  M extends EnginePropsMap<E>,
  S extends EngineSystem<E>,
  R extends ComponentType<any>
>(engine: E, map: M, Root?: R) {
  const requiredPropNames = Object.keys(map.required || {})
  const optionalPropNames = Object.keys(map.optional || {})
  const methodNames = Object.keys(map.methods || {})
  const eventNames = Object.keys(map.events || {})
  const Context = createContext<EngineSystem<E>>(({} as unknown) as any)

  type CompProps = PropsFromPropMap<E, M> & (R extends ComponentType<infer RP> ? RP : {})

  type CompMethods = MethodsFromPropMap<E, M>

  const Component = forwardRef<CompMethods, CompProps>(({ children, ...props }, ref) => {
    const [system] = useState(curry1to0(run, engine))
    const [handlers] = useState(() => {
      return eventNames.reduce((handlers, eventName) => {
        handlers[eventName] = eventHandler(system[map.events![eventName]])
        return handlers
      }, {} as { [key: string]: Emitter<any> })
    })

    for (const ssrProp of map.ssrProps || []) {
      if (ssrProp in props) {
        const stream = system[ssrProp]
        publish(stream, (props as any)[ssrProp])
      }
    }

    useEffect(() => {
      for (const requiredPropName of requiredPropNames.filter(value => !map.ssrProps?.includes(value))) {
        const stream = system[map.required![requiredPropName]]
        publish(stream, (props as any)[requiredPropName])
      }

      for (const optionalPropName of optionalPropNames.filter(value => !map.ssrProps?.includes(value))) {
        if (optionalPropName in props) {
          const stream = system[map.optional![optionalPropName]]
          publish(stream, (props as any)[optionalPropName])
        }
      }

      for (const eventName of eventNames) {
        if (eventName in props) {
          subscribe(handlers[eventName], props[eventName])
        }
      }

      if (system['propsReady']) {
        publish(system['propsReady'], true)
      }

      return () => {
        Object.values(handlers).map(handler => reset(handler))
      }
    }, [props, handlers, system])

    const methodDefs = methodNames.reduce((acc, methodName) => {
      ;(acc as any)[methodName] = (value: any) => {
        const stream = system[map.methods![methodName]]
        publish(stream, value)
      }
      return acc
    }, {} as CompMethods)

    useImperativeHandle(ref, () => methodDefs)

    return (
      <Context.Provider value={system}>
        {Root ? React.createElement(Root, omit([...requiredPropNames, ...optionalPropNames, ...eventNames], props), children) : children}
      </Context.Provider>
    )
  })

  const usePublisher = <K extends keyof S>(key: K) => {
    return curry2to1(publish, React.useContext(Context)[key]) as (value: S[K] extends Stream<infer R> ? R : never) => void
  }

  /**
   * test comment
   */
  const useEmitterValue = <K extends keyof S, V = S[K] extends StatefulStream<infer R> ? R : never>(key: K) => {
    const context = useContext(Context)
    const source: StatefulStream<V> = context[key]
    const initialValue = getValue(source)

    // The boxing value to { value } is because functions (and initialValue may be a callback)
    // are treated specially when used with useState
    const [state, setState] = useState({ value: initialValue })

    useEffect(
      () =>
        subscribe(source, (value: V) => {
          if (value !== state.value) {
            setState({ value })
          }
        }),
      [source, state]
    )

    return state.value
  }

  const useEmitter = <K extends keyof S, V = S[K] extends Stream<infer R> ? R : never>(key: K, callback: (value: V) => void) => {
    const context = useContext(Context)
    const source: Stream<V> = context[key]
    useEffect(() => subscribe(source, callback), [callback, source])
  }

  return { Component, usePublisher, useEmitterValue, useEmitter }
}
