// Bulk Operations API
export const BULK_OPERATION_RUN_QUERY = /* GraphQL */ `
  mutation BulkOperationRunQuery($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {
        id
        status
        url
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const BULK_OPERATION_STATUS_QUERY = /* GraphQL */ `
  query BulkOperationStatus {
    currentBulkOperation {
      id
      status
      errorCode
      objectCount
      fileSize
      url
      createdAt
    }
  }
`;

export const BULK_OPERATION_CANCEL = /* GraphQL */ `
  mutation BulkOperationCancel($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// Query template for bulk export of discount codes
export const BULK_DISCOUNT_CODES_QUERY = /* GraphQL */ `
  {
    discountNodes(first: 10, query: "id:DISCOUNT_NODE_ID") {
      edges {
        node {
          id
          discount {
            ... on DiscountCodeBasic {
              codes(first: 100) {
                edges {
                  node {
                    id
                    code
                    asyncUsageCount
                  }
                }
              }
            }
            ... on DiscountCodeBxgy {
              codes(first: 100) {
                edges {
                  node {
                    id
                    code
                    asyncUsageCount
                  }
                }
              }
            }
            ... on DiscountCodeFreeShipping {
              codes(first: 100) {
                edges {
                  node {
                    id
                    code
                    asyncUsageCount
                  }
                }
              }
            }
            ... on DiscountCodeApp {
              codes(first: 100) {
                edges {
                  node {
                    id
                    code
                    asyncUsageCount
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const SHOP_INFO_QUERY = /* GraphQL */ `
  query ShopInfo {
    shop {
      id
      name
      myshopifyDomain
      currencyCode
      ianaTimezone
    }
  }
`;

const PAGE_INFO = /* GraphQL */ `
  fragment PageInfoFields on PageInfo {
    hasNextPage
    endCursor
  }
`;

const MONEY_FIELDS = /* GraphQL */ `
  fragment MoneyFields on MoneyV2 {
    amount
    currencyCode
  }
`;

const CODE_FIELDS = /* GraphQL */ `
  fragment RedeemCodeFields on DiscountRedeemCode {
    id
    code
    asyncUsageCount
  }
`;

const CUSTOMER_CONTEXT = /* GraphQL */ `
  fragment DiscountContextFields on DiscountContext {
    __typename
    ... on DiscountBuyerSelectionAll {
      all
    }
    ... on DiscountCustomers {
      customers {
        id
        email
        displayName
        firstName
        lastName
        phone
        defaultAddress { phone }
        addresses(first: 5) { phone }
      }
    }
    ... on DiscountCustomerSegments {
      segments {
        id
        name
      }
    }
  }
`;

const MIN_REQUIREMENT = /* GraphQL */ `
  fragment MinimumRequirementFields on DiscountMinimumRequirement {
    __typename
    ... on DiscountMinimumSubtotal {
      greaterThanOrEqualToSubtotal {
        ...MoneyFields
      }
    }
    ... on DiscountMinimumQuantity {
      greaterThanOrEqualToQuantity
    }
  }
`;

const PRODUCT_SCOPE = /* GraphQL */ `
  fragment DiscountItemsFields on DiscountItems {
    __typename
    ... on AllDiscountItems {
      allItems
    }
    ... on DiscountProducts {
      products(first: 100) {
        nodes {
          id
          handle
          title
        }
        pageInfo {
          ...PageInfoFields
        }
      }
      productVariants(first: 100) {
        nodes {
          id
          title
          sku
          product {
            id
            handle
            title
          }
        }
        pageInfo {
          ...PageInfoFields
        }
      }
    }
    ... on DiscountCollections {
      collections(first: 100) {
        nodes {
          id
          handle
          title
        }
        pageInfo {
          ...PageInfoFields
        }
      }
    }
  }
`;

const CUSTOMER_GETS_VALUE = /* GraphQL */ `
  fragment CustomerGetsValueFields on DiscountCustomerGetsValue {
    __typename
    ... on DiscountPercentage {
      percentage
    }
    ... on DiscountAmount {
      appliesOnEachItem
      amount {
        ...MoneyFields
      }
    }
    ... on DiscountOnQuantity {
      quantity {
        quantity
      }
      effect {
        __typename
        ... on DiscountPercentage {
          percentage
        }
        ... on DiscountAmount {
          appliesOnEachItem
          amount {
            ...MoneyFields
          }
        }
      }
    }
  }
`;

const CUSTOMER_BUYS_VALUE = /* GraphQL */ `
  fragment CustomerBuysValueFields on DiscountCustomerBuysValue {
    __typename
    ... on DiscountQuantity {
      quantity
    }
    ... on DiscountPurchaseAmount {
      amount
    }
  }
`;

const DESTINATION_SELECTION = /* GraphQL */ `
  fragment DestinationSelectionFields on DiscountShippingDestinationSelection {
    __typename
    ... on DiscountCountryAll {
      allCountries
    }
    ... on DiscountCountries {
      countries
      includeRestOfWorld
    }
  }
`;

export const LIST_DISCOUNTS_QUERY = /* GraphQL */ `
  ${PAGE_INFO}
  ${MONEY_FIELDS}
  ${CODE_FIELDS}
  ${CUSTOMER_CONTEXT}
  ${MIN_REQUIREMENT}
  ${PRODUCT_SCOPE}
  ${CUSTOMER_GETS_VALUE}
  ${CUSTOMER_BUYS_VALUE}
  ${DESTINATION_SELECTION}

  query ExtractDiscounts($cursor: String, $pageSize: Int!, $query: String) {
    discountNodes(first: $pageSize, after: $cursor, query: $query) {
      pageInfo {
        ...PageInfoFields
      }
      edges {
        node {
          id
          discount {
            __typename
            ... on DiscountCodeBasic {
              title
              status
              startsAt
              endsAt
              createdAt
              updatedAt
              usageLimit
              asyncUsageCount
              appliesOncePerCustomer
              combinesWith {
                productDiscounts
                orderDiscounts
                shippingDiscounts
              }
              context {
                ...DiscountContextFields
              }
              minimumRequirement {
                ...MinimumRequirementFields
              }
              customerGets {
                value {
                  ...CustomerGetsValueFields
                }
                items {
                  ...DiscountItemsFields
                }
              }
              codes(first: 100) {
                nodes {
                  ...RedeemCodeFields
                }
                pageInfo {
                  ...PageInfoFields
                }
              }
            }
            ... on DiscountAutomaticBasic {
              title
              status
              startsAt
              endsAt
              createdAt
              updatedAt
              asyncUsageCount
              combinesWith {
                productDiscounts
                orderDiscounts
                shippingDiscounts
              }
              context {
                ...DiscountContextFields
              }
              minimumRequirement {
                ...MinimumRequirementFields
              }
              customerGets {
                value {
                  ...CustomerGetsValueFields
                }
                items {
                  ...DiscountItemsFields
                }
              }
            }
            ... on DiscountCodeBxgy {
              title
              status
              startsAt
              endsAt
              createdAt
              updatedAt
              usageLimit
              asyncUsageCount
              appliesOncePerCustomer
              usesPerOrderLimit
              combinesWith {
                productDiscounts
                orderDiscounts
                shippingDiscounts
              }
              context {
                ...DiscountContextFields
              }
              customerBuys {
                value {
                  ...CustomerBuysValueFields
                }
                items {
                  ...DiscountItemsFields
                }
              }
              customerGets {
                value {
                  ...CustomerGetsValueFields
                }
                items {
                  ...DiscountItemsFields
                }
              }
              codes(first: 100) {
                nodes {
                  ...RedeemCodeFields
                }
                pageInfo {
                  ...PageInfoFields
                }
              }
            }
            ... on DiscountAutomaticBxgy {
              title
              status
              startsAt
              endsAt
              createdAt
              updatedAt
              asyncUsageCount
              combinesWith {
                productDiscounts
                orderDiscounts
                shippingDiscounts
              }
              context {
                ...DiscountContextFields
              }
              customerBuys {
                value {
                  ...CustomerBuysValueFields
                }
                items {
                  ...DiscountItemsFields
                }
              }
              customerGets {
                value {
                  ...CustomerGetsValueFields
                }
                items {
                  ...DiscountItemsFields
                }
              }
            }
            ... on DiscountCodeFreeShipping {
              title
              status
              startsAt
              endsAt
              createdAt
              updatedAt
              usageLimit
              asyncUsageCount
              appliesOncePerCustomer
              appliesOnOneTimePurchase
              appliesOnSubscription
              recurringCycleLimit
              combinesWith {
                productDiscounts
                orderDiscounts
                shippingDiscounts
              }
              context {
                ...DiscountContextFields
              }
              minimumRequirement {
                ...MinimumRequirementFields
              }
              maximumShippingPrice {
                ...MoneyFields
              }
              destinationSelection {
                ...DestinationSelectionFields
              }
              codes(first: 100) {
                nodes {
                  ...RedeemCodeFields
                }
                pageInfo {
                  ...PageInfoFields
                }
              }
            }
            ... on DiscountAutomaticFreeShipping {
              title
              status
              startsAt
              endsAt
              createdAt
              updatedAt
              asyncUsageCount
              appliesOnOneTimePurchase
              appliesOnSubscription
              recurringCycleLimit
              combinesWith {
                productDiscounts
                orderDiscounts
                shippingDiscounts
              }
              context {
                ...DiscountContextFields
              }
              minimumRequirement {
                ...MinimumRequirementFields
              }
              maximumShippingPrice {
                ...MoneyFields
              }
              destinationSelection {
                ...DestinationSelectionFields
              }
            }
            ... on DiscountCodeApp {
              title
              status
              startsAt
              endsAt
              createdAt
              updatedAt
              usageLimit
              asyncUsageCount
              appliesOncePerCustomer
              appliesOnOneTimePurchase
              appliesOnSubscription
              recurringCycleLimit
              combinesWith {
                productDiscounts
                orderDiscounts
                shippingDiscounts
              }
              context {
                ...DiscountContextFields
              }
              appDiscountType {
                appKey
                functionId
                title
                description
                discountClasses
              }
              codes(first: 100) {
                nodes {
                  ...RedeemCodeFields
                }
                pageInfo {
                  ...PageInfoFields
                }
              }
            }
            ... on DiscountAutomaticApp {
              title
              status
              startsAt
              endsAt
              createdAt
              updatedAt
              asyncUsageCount
              appliesOnOneTimePurchase
              appliesOnSubscription
              recurringCycleLimit
              combinesWith {
                productDiscounts
                orderDiscounts
                shippingDiscounts
              }
              context {
                ...DiscountContextFields
              }
              appDiscountType {
                appKey
                functionId
                title
                description
                discountClasses
              }
            }
          }
        }
      }
    }
  }
`;

export const PAGINATE_CODES_QUERY = /* GraphQL */ `
  ${PAGE_INFO}
  ${CODE_FIELDS}

  query PaginateDiscountCodes($id: ID!, $cursor: String, $pageSize: Int!) {
    node(id: $id) {
      ... on DiscountCodeNode {
        codeDiscount {
          __typename
          ... on DiscountCodeBasic {
            codes(first: $pageSize, after: $cursor) {
              nodes {
                ...RedeemCodeFields
              }
              pageInfo {
                ...PageInfoFields
              }
            }
          }
          ... on DiscountCodeBxgy {
            codes(first: $pageSize, after: $cursor) {
              nodes {
                ...RedeemCodeFields
              }
              pageInfo {
                ...PageInfoFields
              }
            }
          }
          ... on DiscountCodeFreeShipping {
            codes(first: $pageSize, after: $cursor) {
              nodes {
                ...RedeemCodeFields
              }
              pageInfo {
                ...PageInfoFields
              }
            }
          }
          ... on DiscountCodeApp {
            codes(first: $pageSize, after: $cursor) {
              nodes {
                ...RedeemCodeFields
              }
              pageInfo {
                ...PageInfoFields
              }
            }
          }
        }
      }
    }
  }
`;

export const DISCOUNT_METAFIELDS_QUERY = /* GraphQL */ `
  ${PAGE_INFO}

  query DiscountMetafields($id: ID!, $cursor: String, $pageSize: Int!) {
    node(id: $id) {
      ... on DiscountCodeNode {
        metafields(first: $pageSize, after: $cursor) {
          nodes {
            id
            namespace
            key
            type
            value
          }
          pageInfo {
            ...PageInfoFields
          }
        }
      }
      ... on DiscountAutomaticNode {
        metafields(first: $pageSize, after: $cursor) {
          nodes {
            id
            namespace
            key
            type
            value
          }
          pageInfo {
            ...PageInfoFields
          }
        }
      }
    }
  }
`;
