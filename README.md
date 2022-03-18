<div id="top"></div>

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <!-- <a href="https://github.com/Nando-C/UnQ-BE">
    <img src="" alt="Logo" height="100">
  </a> -->

<h3 align="center">UnQ -> [Back-End]</h3>

  <p align="center">
    A Food & Drinks Ordering Application, solo capstone project developed for Strive School's Full Stack program!
    <br />
    <br />
    <a href="#try-customer-interface">View Demo</a>
    <!-- ·
    <a href="https://github.com/Nando-C/UnQ-BE/issues">Report Bug</a> -->
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li><a href="#models">Models</a>
     <ul>
        <li><a href="#user">User</a></li>
        <li><a href="#shop">Shop</a></li>
        <li><a href="#menu">Menu</a></li>
        <li><a href="#cart">Cart</a></li>
      </ul>
    </li>
    <li><a href="#api">API</a>
     <ul>
        <li><a href="#authorization">Authorization</a></li>
        <li><a href="#users">Users</a></li>
        <li><a href="#shops">Shops</a></li>
        <li><a href="#carts">Carts</a></li>
      </ul>
    </li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->

## About The Project

<!-- [![Product Name Screen Shot][product-screenshot]](https://example.com) -->

This is the Back-End of my Solo Capstone project for the Full Stack Master Camp at Strive School.

Developed completly from (not having idea of what to conceive) concept to deployment in 5 weeks, implementing both the Font-End & Back-End from scratch within this time frame.

In reality this is a MVP (Minimal Viable Product) that I am planning to improve in the near future, but still makes me really proud! 😁

You can find the Front-End repo of this project in the following link, where more information about the use of this app is shared: [UnQ's Front-End](https://github.com/Nando-C/UnQ-FE)

<p align="right">(<a href="#top">back to top</a>)</p>

### Built With

- [TypeScript](https://typescriptlang.org/)
- [Node.js](https://nodejs.org/)
- [Express.js](https://expressjs.com/)
- [MongoDB](https://www.mongodb.com/)
- [Cloudinary](https://cloudinary.com)
- Love ❤️ and lots of coffee ☕️

<p align="right">(<a href="#top">back to top</a>)</p>

<!-- MODELS EXAMPLES -->

## Models

I have used MongoDB with Mongoose to model the data for this application, creating four main models as shown below.

### User

```js
User Model:
    {
        name: string,
        surname: string,
        email: string,
        password: string,
        avatar: string,
        role: {
            type: String,
            enum: ["customer", "shopMg"],
        },
        refreshToken: string,
        googleId: string,
    }
```

<p align="right">(<a href="#top">back to top</a>)</p>

### Shop

```js
Shop Model:
    {
        name: string,
        cover: string,
        bio: string,
        open_times: string,
        phone: number,
        web_URL: string,
        shopMg: {
            type: ObjectId,
            ref: "User",
        },
        tables: [
            {
                name: string,
                Qr_Url: string,
            },
        ],
        menu: [
            {
                type: ObjectId,
                ref: "MenuItem",
            },
        ],
    }
```

<p align="right">(<a href="#top">back to top</a>)</p>

### Menu

```js
MenuItem Model:
    {
        name: string,
        image: string,
        short_description: string,
        description: string,
        price: number,
        available: boolean,
        category: {
            type: String,
            enum: ["food", "drinks"],
        },
    }
```

<p align="right">(<a href="#top">back to top</a>)</p>

### Cart

```js
Cart Model:
    {
        userId: {
            type: ObjectId,
            ref: "User",
        },
        shopId: {
            type: ObjectId,
            ref: "Shop",
        },
        tableId: string,
        status: {
            type: String,
            enum: ["open", "splitted", "closed"],
        },
        items: [
            {
                menuId: {
                    type: ObjectId,
                    ref: "Menu",
                },
                qty: number,
                qtyPayed: number,
            }
        ],
        split: [
            {
                userId: {
                    type: ObjectId,
                    ref: "User",
                },
                menuId: {
                    type: ObjectId,
                    ref: "Menu",
                },
                qty: number,
                splitStatus: {
                    type: String,
                    enum: ["open", "closed"],
                },
            }
        ],
    }
```

<p align="right">(<a href="#top">back to top</a>)</p>

## API

These are the available endpoints for this application.

### Authorization

- [ 'POST' ]

  baseURL-api/auth/refreshToken

- [ 'POST' ]

  baseURL-api/auth/register

- [ 'POST' ]

  baseURL-api/auth/login

- [ 'GET' ]

  baseURL-api/auth/logout

- [ 'GET' ]

  baseURL-api/auth/googleLogin

- [ 'GET' ]

  baseURL-api/auth/googleRedirect

<p align="right">(<a href="#top">back to top</a>)</p>

### Users

baseURL-api/users/me
baseURL-api/users/me/avatar

<p align="right">(<a href="#top">back to top</a>)</p>

### Shops

baseURL-api/shops
baseURL-api/shops/:shopId
baseURL-api/shops/:shopId/cover
baseURL-api/shops/:shopId/tables
baseURL-api/shops/:shopId/tables/:tableId
baseURL-api/shops/:shopId/menu
baseURL-api/shops/:shopId/menu/:itemId
baseURL-api/shops/:shopId/menu/:itemId/img

<p align="right">(<a href="#top">back to top</a>)</p>

### Carts

baseURL-api/carts/:shopId/tables/:tableId/addItem'
baseURL-api/carts/:shopId/tables/:tableId/removeItem'
baseURL-api/carts/:shopId/tables/:tableId/deleteItem'
baseURL-api/carts/:shopId/tables/:tableId/:cartId/addSplitItem'
baseURL-api/carts/:shopId/tables/:tableId/:cartId/decreaseSplitItem'
baseURL-api/carts/:shopId/tables/:tableId/:cartId/removeSplitItem'
baseURL-api/carts/tables/:tableId/:cartId/checkOutSplitItem'
baseURL-api/carts/tables/:tableId'
baseURL-api/carts'
baseURL-api/carts/:cartId'

<p align="right">(<a href="#top">back to top</a>)</p>

<!-- CONTACT -->

## Contact

[@Nando](https://hernando-crespo.vercel.app/) - Get in touch and let me know what do you think of this project! 😉

<p align="right">(<a href="#top">back to top</a>)</p>
