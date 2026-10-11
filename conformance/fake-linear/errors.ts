import { GraphQLError } from "graphql"

/** Errors shaped like the ones api.linear.app returns. */
export class LinearError extends GraphQLError {
  static notFound(typename: string): LinearError {
    return new LinearError(`Entity not found: ${typename}`, {
      extensions: {
        type: "invalid input",
        code: "INPUT_ERROR",
        statusCode: 400,
        userError: true,
        userPresentableMessage: `Could not find referenced ${typename}.`,
      },
    })
  }

  static input(message: string, userPresentableMessage = message): LinearError {
    return new LinearError(message, {
      extensions: {
        type: "invalid input",
        code: "INPUT_ERROR",
        statusCode: 400,
        userError: true,
        userPresentableMessage,
      },
    })
  }
}
